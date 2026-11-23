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
import { isUnder, joinPath, realpath, suffix, truthy } from "./common.ts";
import { ShlexError, splitWithOperators } from "./shlex.ts";

// A superset pre-filter: anything it lets through is tokenized and checked.
// It reads the command without quotes, escapes, and line continuations, which
// the shell splices out of a word (`r"m"`, `r\m`, `r\<newline>m` all run rm).
const FAST_REJECT = /\b(?:obsidian-cli|mv|rm)\b/;
const SPLICED = /\\\n|["'\\]/g;
const SEPARATOR = /^[();|&\n]+$/;
const REDIRECT_OPERATORS = new Set([">", ">>", "<", "<<", "&>", "&>>", ">&", "<&"]);

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

function splitSubcommands(tokens: string[]): string[][] {
  const subcommands: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (SEPARATOR.test(token)) {
      if (current.length > 0) subcommands.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) subcommands.push(current);
  return subcommands;
}

/** Drop each redirection operator and its operand (`> file`, `2>&1`). */
function stripRedirections(tokens: string[]): string[] {
  const kept: string[] = [];
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
    } else if (REDIRECT_OPERATORS.has(token)) {
      skipNext = true;
    } else {
      kept.push(token);
    }
  }
  return kept;
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
  if (!FAST_REJECT.test(command.replace(SPLICED, ""))) return null;
  let tokens: string[];
  try {
    tokens = splitWithOperators(command);
  } catch (error) {
    if (error instanceof ShlexError) return null;
    throw error;
  }

  const subcommands = splitSubcommands(tokens).map(stripRedirections);
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
  const base = truthy(cwd) ? cwd : ".";
  if (typeof base !== "string") return null;
  const resolvedCwd = realpath(base);
  for (const [sub, args] of mvRm) {
    const message = checkVaultMvRm(sub, args, resolvedCwd, roots, command);
    if (message) return message;
  }
  return null;
}
