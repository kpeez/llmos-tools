/**
 * PreToolUse guard for Bash: obsidian-cli targeting, and raw `mv`/`rm` on
 * vault notes.
 *
 * It runs on every Bash call, so a cheap word-boundary pre-filter runs
 * before any tokenizing, and vault roots are read only once an actual
 * `mv`/`git mv`/`rm`/`git rm` invocation is found. Tokenizing keeps shell
 * operators (`&&`, `;`, `|`, `&`, parentheses, newlines, redirections) as
 * their own tokens even when glued to a word (`hi&&rm`), while respecting
 * quotes. Every operator token except a redirection starts a new subcommand.
 * A redirection and its operand are never treated as command arguments.
 *
 * Two rules deny the call (exit code 2, message on stderr):
 *
 * 1. An `obsidian-cli` note verb (`read`, `delete`, `move`, ...) that names
 *    neither `file=` nor `path=` acts on whatever note the app has focused.
 *    Verbs with their own `active` flag (`aliases`, `properties`, `tags`,
 *    `tasks`) list vault-wide by default and are not denied.
 * 2. Raw `mv`, `git mv`, `rm`, or `git rm` on a `.md` file under any known
 *    vault root (the llmOS root and Obsidian's registry) orphans the
 *    wikilinks to it; `obsidian-cli move`/`rename` rewrites them.
 *
 * Any failure (no vault configured, an unparsable command) approves.
 */

import { registeredVaults, VaultRootError, vaultRoot } from "../root.ts";
import { isUnder, joinPath, pathFrom, realpath, suffix } from "./common.ts";
import { ShlexError, splitShellLines, splitWithOperators } from "./shlex.ts";

// A superset pre-filter: anything it lets through is tokenized and checked.
// The shell splices quotes, escapes, and line continuations out of a word
// (`r"m"`, `r\m`, `r\<newline>m` all run rm), so the filter also reads the
// command with them removed; it keeps the raw reading, because a backslash
// in a comment is not a continuation.
const FAST_REJECT = /\b(?:obsidian-cli|mv|rm)\b/;
const OPERATOR_TOKENS = new Set(["&&", "||", ";", "|"]);
const REDIRECT_OPERATORS = new Set([">", ">>", "<", "<<", "&>", "&>>", ">&", "<&"]);
const QUOTES_AND_ESCAPES = /["'\\]/g;
const CONTINUATION = /\\\n/g;
const OPERATOR = /^[();|&<>\n]+$/;
const SEPARATES = /[();|&\n]/;
const CLOBBER = />\|/g;
const REDIRECT_AMPERSAND = /&(?=>)|(?<=[<>])&/g;
const REDIRECTS = /[<>]&?$/;
const FD_NUMBER = /^\d+$/;

/**
 * obsidian-cli verbs where an omitted `file=`/`path=` falls back to the
 * active note (per `obsidian-cli help`). Verbs with other targeting
 * (`task` via `ref=`, `bookmark` via `folder=`/`search=`) are left out,
 * because a missing `file=`/`path=` alone is not a reliable signal there.
 */
const NOTE_TARGETING_VERBS = new Set([
  "read",
  "append",
  "prepend",
  "delete",
  "move",
  "rename",
  "backlinks",
  "links",
  "outline",
  "file",
  "wordcount",
  "property:read",
  "property:set",
  "property:remove",
  "diff",
  "history",
  "history:read",
  "history:restore",
  "sync:read",
  "sync:restore",
  "sync:history",
]);

function basename(token: string): string {
  return token.slice(token.lastIndexOf("/") + 1);
}

/**
 * The subcommands of the Python-style token list, split only on the four
 * operator tokens, with each listed redirection and its operand dropped.
 */
function pythonSubcommands(tokens: string[]): string[][] {
  const subcommands: string[][] = [];
  let current: string[] = [];
  let skipNext = false;
  for (const token of tokens) {
    if (OPERATOR_TOKENS.has(token)) {
      if (current.length > 0) subcommands.push(current);
      current = [];
      skipNext = false;
    } else if (skipNext) {
      skipNext = false;
    } else if (REDIRECT_OPERATORS.has(token)) {
      skipNext = true;
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) subcommands.push(current);
  return subcommands;
}

/**
 * The words of each subcommand of the shell-line token list. An operator run
 * can both end a subcommand and redirect (`;`, a newline, then `>`), so each
 * part applies: a separator character starts a new subcommand, and a run that
 * ends in `<` or `>` drops the next word, the redirection's operand, with any
 * file-descriptor number before it (`2>/dev/null`). The `&` of `&>`, `>&`, and
 * `<&`, and the `|` of `>|`, belong to the redirection and separate nothing.
 */
function shellSubcommands(rawTokens: string[]): string[][] {
  const tokens = rawTokens.map((token) =>
    OPERATOR.test(token) ? token.replace(CLOBBER, ">") : token,
  );
  const subcommands: string[][] = [];
  let current: string[] = [];
  let skipOperand = false;
  tokens.forEach((token, index) => {
    if (OPERATOR.test(token)) {
      if (SEPARATES.test(token.replace(REDIRECT_AMPERSAND, ""))) {
        if (current.length > 0) subcommands.push(current);
        current = [];
      }
      skipOperand = REDIRECTS.test(token);
    } else if (skipOperand) {
      skipOperand = false;
    } else if (!(FD_NUMBER.test(token) && REDIRECTS.test(tokens[index + 1] ?? ""))) {
      current.push(token);
    }
  });
  if (current.length > 0) subcommands.push(current);
  return subcommands;
}

/**
 * The subcommands of one reading of `command`, or none when it cannot be
 * tokenized. The guard checks both readings, so it denies every command the
 * Python-style reading denied and also what the shell-line reading finds.
 */
function readSubcommands(
  command: string,
  tokenize: (command: string) => string[],
  split: (tokens: string[]) => string[][],
): string[][] {
  try {
    return split(tokenize(command));
  } catch (error) {
    if (error instanceof ShlexError) return [];
    throw error;
  }
}

function mayNameGuardedCommand(command: string): boolean {
  return [
    command,
    command.replace(QUOTES_AND_ESCAPES, ""),
    command.replace(CONTINUATION, "").replace(QUOTES_AND_ESCAPES, ""),
  ].some((reading) => FAST_REJECT.test(reading));
}

function obsidianCliVerb(tokens: string[]): string | null {
  if (tokens.length === 0 || basename(tokens[0] as string) !== "obsidian-cli") return null;
  for (const token of tokens.slice(1)) {
    if (token.startsWith("vault=") || token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function checkObsidianCli(tokens: string[]): string | null {
  const verb = obsidianCliVerb(tokens);
  if (verb === null || !NOTE_TARGETING_VERBS.has(verb)) return null;
  if (tokens.some((token) => token.startsWith("file=") || token.startsWith("path="))) return null;
  return (
    `obsidian-cli '${verb}' names no file= or path=: it will silently act on ` +
    "whatever note is currently focused in the Obsidian app. Pass " +
    "file=<name> (resolves like a wikilink) or path=<exact/path.md> to target " +
    "the note explicitly."
  );
}

function mvRmArgs(tokens: string[]): string[] | null {
  if (tokens.length === 0) return null;
  const name = basename(tokens[0] as string);
  let rest: string[];
  if (name === "mv" || name === "rm") rest = tokens.slice(1);
  else if (name === "git" && (tokens[1] === "mv" || tokens[1] === "rm")) rest = tokens.slice(2);
  else return null;
  return rest.filter((token) => !token.startsWith("-"));
}

/** Every known vault root, resolved so it matches a resolved argument. */
function knownVaultRoots(): string[] {
  const roots: string[] = [];
  try {
    roots.push(vaultRoot());
  } catch (error) {
    if (!(error instanceof VaultRootError)) throw error;
  }
  try {
    roots.push(...registeredVaults());
  } catch (error) {
    if (!(error instanceof VaultRootError)) throw error;
  }
  return [...new Set(roots.map((root) => realpath(root)))];
}

function checkVaultMvRm(
  tokens: string[],
  args: string[],
  cwd: string,
  roots: string[],
  rawCommand: string,
): string | null {
  const program =
    basename(tokens[0] as string) === "git" ? `git ${tokens[1]}` : basename(tokens[0] as string);
  for (const arg of args) {
    const path = realpath(arg.startsWith("/") ? arg : joinPath(cwd, arg || "."));
    if (suffix(path).toLowerCase() !== ".md") continue;
    if (roots.some((root) => isUnder(path, root))) {
      return (
        `'${rawCommand}' touches a vault note (${path}) with raw ${program}: this ` +
        "orphans any wikilinks pointing at it. Use `obsidian-cli move " +
        "file=<name> to=<dest>` (or `obsidian-cli rename`) so backlinks get " +
        "rewritten."
      );
    }
  }
  return null;
}

/** The deny message for `command`, or `null` to approve. */
export function checkCommand(command: string, cwd: unknown): string | null {
  if (!mayNameGuardedCommand(command)) return null;
  const subcommands = [
    ...readSubcommands(command, splitWithOperators, pythonSubcommands),
    ...readSubcommands(command, splitShellLines, shellSubcommands),
  ];
  if (subcommands.length === 0) return null;
  for (const sub of subcommands) {
    const message = checkObsidianCli(sub);
    if (message) return message;
  }

  const mvRm: [string[], string[]][] = [];
  for (const sub of subcommands) {
    const args = mvRmArgs(sub);
    if (args !== null) mvRm.push([sub, args]);
  }
  if (mvRm.length === 0) return null;

  const roots = knownVaultRoots();
  if (roots.length === 0) return null;
  const resolvedCwd = pathFrom(cwd);
  if (resolvedCwd === null) return null;
  for (const [sub, args] of mvRm) {
    const message = checkVaultMvRm(sub, args, resolvedCwd, roots, command);
    if (message) return message;
  }
  return null;
}
