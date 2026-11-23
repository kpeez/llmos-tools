/**
 * The grammar check of the Bash guard. `unbash` parses the command into a
 * tree. The walk visits every simple command wherever it sits (in `$( )`,
 * backticks, `{ }`, `if`, a function body, a here-document, a `bash -c`
 * string) and looks through a wrapper (`sudo`, `env`, `timeout`, `xargs`).
 * Then it checks the raw `mv`, `rm`, `git mv`, `git rm`, and `find -delete`
 * calls against the vault roots. It only adds denials: `guard.ts` runs it
 * after the older token check and denies when either one denies.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { parse } from "unbash";
import { expandUser, isDir, isSymlink, isUnder, joinPath, realpath, suffix } from "./common.ts";

interface Node {
  type?: string;
  [key: string]: unknown;
}

/** One simple command after its wrappers are removed. */
export interface Invocation {
  words: string[];
  /** The words of the commands that feed this one through a pipe. */
  feeders: string[][];
  /** The operand of `< file`. */
  stdinFile: string | null;
  /** The command runs under `xargs`, so its last arguments come from stdin. */
  viaXargs: boolean;
}

/** `unbash` builds these children on first read, so `Object.values` misses them. */
const LAZY_CHILDREN = ["parts", "script", "value", "elements"];
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20_000;
const MAX_LIST_BYTES = 1_000_000;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_COMMAND_FLAG = /^-[a-z]*c[a-z]*$/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const GLOB = /[*?[]/;
const RECURSIVE = /^-[A-Za-z]*[rR]/;
const FIND_PREDICATE_START = new Set(["(", ")", "!", ","]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Wrapper programs, each with the options that take a separate argument. */
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "-S"]),
  timeout: new Set(["-s", "-k"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
  nohup: new Set(),
  time: new Set(),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  setsid: new Set(),
  xargs: new Set(["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a", "-J", "-R", "-S"]),
};

function basename(token: string): string {
  return token.slice(token.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function nodes(value: unknown): Node[] {
  return Array.isArray(value) ? (value as Node[]) : [];
}

function wordsOf(command: Node): string[] {
  const words: string[] = [];
  const name = command.name as Node | undefined;
  if (typeof name?.value === "string") words.push(name.value);
  for (const part of nodes(command.suffix)) {
    if (part.type === "Word" && typeof part.value === "string") words.push(part.value);
  }
  return words;
}

function hereDocText(command: Node): string | null {
  for (const part of nodes(command.suffix)) {
    const body = part.type === "HereDoc" ? (part.body as Node | undefined) : undefined;
    if (typeof body?.text === "string") return body.text;
  }
  return null;
}

function stdinFileOf(command: Node): string | null {
  for (const part of nodes(command.suffix)) {
    const target = part.type === "Redirect" && part.operator === "<" ? (part.target as Node) : null;
    if (typeof target?.value === "string") return target.value;
  }
  return null;
}

function skipWrapper(words: string[], name: string): string[] {
  const takesArgument = WRAPPERS[name] as Set<string>;
  let index = 1;
  let durationSeen = false;
  while (index < words.length) {
    const token = words[index] as string;
    if (token === "--") {
      index++;
      break;
    }
    if (token.startsWith("-") && token.length > 1) {
      index += takesArgument.has(token) ? 2 : 1;
    } else if (name === "env" && ASSIGNMENT.test(token)) {
      index++;
    } else if (name === "timeout" && !durationSeen && /^\d/.test(token)) {
      durationSeen = true;
      index++;
    } else break;
  }
  return words.slice(index);
}

function shellScript(words: string[], here: string | null): string | null {
  const flag = words.findIndex((token, index) => index > 0 && SHELL_COMMAND_FLAG.test(token));
  if (flag >= 0) return words[flag + 1] ?? null;
  return here;
}

function addInvocation(command: Node, feeders: string[][], out: Invocation[], depth: number): void {
  let words = wordsOf(command);
  let viaXargs = false;
  for (let step = 0; step < 8 && words.length > 0; step++) {
    const name = basename(words[0] as string);
    if (SHELLS.has(name) || name === "eval") {
      const script =
        name === "eval" ? words.slice(1).join(" ") : shellScript(words, hereDocText(command));
      if (script !== null && depth < MAX_DEPTH) collect(parse(script), [], out, depth + 1);
      return;
    }
    if (!(name in WRAPPERS)) break;
    if (name === "xargs") viaXargs = true;
    words = skipWrapper(words, name);
  }
  if (words.length > 0) {
    out.push({ words, feeders, stdinFile: stdinFileOf(command), viaXargs });
  }
}

function collect(node: unknown, feeders: string[][], out: Invocation[], depth: number): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, feeders, out, depth);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const current = node as Node;
  if (current.type === "Pipeline") {
    const earlier: string[][] = [];
    for (const child of nodes(current.commands)) {
      collect(child, [...earlier], out, depth);
      if (child.type === "Command") earlier.push(wordsOf(child));
    }
    return;
  }
  if (current.type === "Command") addInvocation(current, feeders, out, depth);
  const inner = current.type === "Command" ? [] : feeders;
  for (const value of [...Object.values(current), ...LAZY_CHILDREN.map((key) => current[key])]) {
    if (typeof value === "object") collect(value, inner, out, depth);
  }
}

/** Every simple command of `command`, wrappers removed; none when it does not parse. */
export function invocations(command: string): Invocation[] {
  const out: Invocation[] = [];
  collect(parse(command), [], out, 0);
  return out;
}

function globToRegExp(pattern: string, ignoreCase: boolean): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[" || char === "]") source += char;
    else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, ignoreCase ? "i" : "");
  } catch {
    return /^/;
  }
}

type Accept = (name: string) => boolean;

/** A dot folder or `node_modules` holds no vault note (`resolveInVault` refuses the first). */
function hidden(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/**
 * Whether `folder` holds a note that `accept` takes. A folder with more than
 * `MAX_ENTRIES` entries counts as holding one: the check fails closed.
 */
function containsNote(folder: string, accept: Accept): boolean {
  const pending = [folder];
  let seen = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(next, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (hidden(entry.name)) continue;
      if (++seen > MAX_ENTRIES) return true;
      if (entry.isDirectory()) pending.push(joinPath(next, entry.name));
      else if (entry.isFile() && suffix(entry.name) === ".md" && accept(entry.name)) return true;
    }
  }
  return false;
}

interface Context {
  base: string | null;
  roots: string[];
}

/**
 * The note or folder of `arg` that a raw command would move or delete, or
 * null. `folders` reads a folder as all the notes under it.
 */
function argHit(
  arg: string,
  context: Context,
  folders: boolean,
  accept: Accept = () => true,
  followsLink = true,
) {
  const candidates = arg.startsWith("~") ? [arg, expandUser(arg)] : [arg];
  for (const candidate of candidates) {
    if (!candidate.startsWith("/") && context.base === null) continue;
    const typed = candidate.startsWith("/")
      ? candidate
      : joinPath(context.base as string, candidate || ".");
    const path = realpath(typed);
    const hit = pathHit(
      path,
      context.roots,
      folders && !(!followsLink && namesLink(typed)),
      accept,
    );
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Whether `typed` names a symbolic link itself. Without a trailing slash a
 * plain `rm`, `mv`, `git rm`, or `git mv` acts on the link and leaves the
 * folder it points to. With a trailing slash, they act on that folder. A
 * `find` with `-H`, `-L`, or `-follow`, and a program that lists paths for
 * `xargs`, follow the link either way, so only the direct `mv`/`rm` call
 * passes `followsLink = false`.
 */
function namesLink(typed: string): boolean {
  if (typed.endsWith("/")) return false;
  return isSymlink(joinPath(realpath(dirname(typed)), basename(typed)));
}

function pathHit(path: string, roots: string[], folders: boolean, accept: Accept): string | null {
  const name = basename(path);
  if (GLOB.test(name)) return globHit(path, roots, folders, accept);
  if (suffix(path) === ".md" && roots.some((root) => isUnder(path, root))) {
    return accept(name) ? path : null;
  }
  if (!folders || !isDir(path)) return null;
  for (const root of roots) {
    const inside = isUnder(path, root);
    if (inside && path.slice(root.length).split("/").some(hidden)) continue;
    const walk = inside ? path : isUnder(root, path) ? root : null;
    if (walk !== null && containsNote(walk, accept)) return path;
  }
  return null;
}

function globHit(path: string, roots: string[], folders: boolean, accept: Accept): string | null {
  const folder = dirname(path);
  if (!roots.some((root) => isUnder(folder, root) || isUnder(root, folder))) return null;
  const pattern = globToRegExp(basename(path), false);
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (hidden(entry.name) || !pattern.test(entry.name)) continue;
    const full = joinPath(folder, entry.name);
    if (entry.isFile() && suffix(entry.name) === ".md" && accept(entry.name)) return full;
    if (folders && entry.isDirectory() && containsNote(full, accept)) return full;
  }
  return null;
}

function nonOptions(words: string[]): string[] {
  const dashes = words.indexOf("--");
  return dashes < 0
    ? words.filter((token) => !token.startsWith("-"))
    : [
        ...words.slice(0, dashes).filter((token) => !token.startsWith("-")),
        ...words.slice(dashes + 1),
      ];
}

interface MvRm {
  program: string;
  args: string[];
  recursive: boolean;
  gitFolder: string | null;
}

function mvRmOf(words: string[]): MvRm | null {
  const name = basename(words[0] as string);
  if (name === "mv" || name === "rm") {
    return { program: name, args: words.slice(1), recursive: false, gitFolder: null };
  }
  if (name !== "git") return null;
  let gitFolder: string | null = null;
  for (let index = 1; index < words.length; index++) {
    const token = words[index] as string;
    if (token === "-C") gitFolder = words[++index] ?? null;
    else if (token === "-c" || token === "--exec-path" || token === "--namespace") index++;
    else if (token === "mv" || token === "rm") {
      return { program: `git ${token}`, args: words.slice(index + 1), recursive: false, gitFolder };
    } else if (!token.startsWith("-")) return null;
  }
  return null;
}

interface FindCall {
  starts: string[];
  patterns: RegExp[];
  deletes: boolean;
}

function findOf(words: string[]): FindCall | null {
  if (basename(words[0] as string) !== "find") return null;
  let index = 1;
  while (/^-[HLP]$|^-O\d$/.test(words[index] ?? "") || words[index] === "-D") {
    index += words[index] === "-D" ? 2 : 1;
  }
  const starts: string[] = [];
  while (index < words.length) {
    const token = words[index] as string;
    if (token.startsWith("-") || FIND_PREDICATE_START.has(token)) break;
    starts.push(token);
    index++;
  }
  const rest = words.slice(index);
  const patterns: RegExp[] = [];
  const types: string[] = [];
  let deletes = rest.includes("-delete");
  rest.forEach((token, at) => {
    const next = rest[at + 1] ?? "";
    if (token === "-name" || token === "-iname")
      patterns.push(globToRegExp(next, token === "-iname"));
    else if (token === "-type") types.push(next);
    else if (FIND_EXEC.has(token)) {
      const inner = mvRmOf(next === "" ? [] : rest.slice(at + 1));
      if (inner !== null) deletes = true;
    }
  });
  if (types.length > 0 && types.every((type) => type === "d")) deletes = false;
  return { starts: starts.length > 0 ? starts : ["."], patterns, deletes };
}

function listEntries(path: string, context: Context): string[] {
  try {
    const resolved = realpath(path.startsWith("/") ? path : joinPath(context.base ?? "/", path));
    if (statSync(resolved).size > MAX_LIST_BYTES) return [];
    return readFileSync(resolved, "utf8")
      .split(/[\n\0]/)
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

function feederHit(words: string[], context: Context): string | null {
  const name = basename(words[0] as string);
  const find = findOf(words);
  if (find !== null) {
    const accept: Accept = (file) =>
      find.patterns.length === 0 || find.patterns.some((p) => p.test(file));
    for (const start of find.starts) {
      const hit = argHit(start, context, true, accept);
      if (hit !== null) return hit;
    }
    return null;
  }
  const paths = nonOptions(words.slice(1));
  if (name === "cat") {
    for (const file of paths) {
      for (const entry of listEntries(file, context)) {
        const hit = argHit(entry, context, false);
        if (hit !== null) return hit;
      }
    }
    return null;
  }
  for (const path of paths.length > 0 || !["ls", "fd"].includes(name) ? paths : ["."]) {
    const hit = argHit(path, context, true);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * `subject` is text the agent typed (an argument, a list file). The deny
 * reason never prints a path found by a glob or in a list, because a note
 * name can hold a newline; `JSON.stringify` escapes the control characters.
 */
function message(command: string, subject: string, program: string): string {
  return (
    `'${command}' touches a vault note or a folder of notes (${JSON.stringify(subject)}) with raw ${program}: this ` +
    "orphans any wikilinks pointing at it. Use `obsidian-cli move " +
    "file=<name> to=<dest>` (or `obsidian-cli rename`) so backlinks get " +
    "rewritten."
  );
}

/** The deny message for one simple command that moves or deletes vault notes, else null. */
export function vaultDenial(
  invocation: Invocation,
  cwd: string | null,
  roots: string[],
  command: string,
): string | null {
  const { words } = invocation;
  const find = findOf(words);
  if (find !== null) {
    if (!find.deletes) return null;
    const context = { base: cwd, roots };
    const accept: Accept = (file) =>
      find.patterns.length === 0 || find.patterns.some((p) => p.test(file));
    for (const start of find.starts) {
      if (argHit(start, context, true, accept) !== null) {
        return message(command, start, "find -delete");
      }
    }
    return null;
  }
  const call = mvRmOf(words);
  if (call === null) return null;
  const base =
    call.gitFolder === null
      ? cwd
      : call.gitFolder.startsWith("/")
        ? call.gitFolder
        : cwd === null
          ? null
          : joinPath(cwd, call.gitFolder);
  const context = { base, roots };
  const folders =
    call.program === "mv" ||
    call.program === "git mv" ||
    call.args.some((a) => RECURSIVE.test(a) || a === "--recursive");
  for (const arg of nonOptions(call.args)) {
    if (argHit(arg, context, folders, undefined, false) !== null) {
      return message(command, arg, call.program);
    }
  }
  if (!invocation.viaXargs) return null;
  const { stdinFile } = invocation;
  if (
    stdinFile !== null &&
    listEntries(stdinFile, context).some((e) => argHit(e, context, false))
  ) {
    return message(command, `< ${stdinFile}`, `xargs ${call.program}`);
  }
  for (const feeder of invocation.feeders) {
    if (feeder.length > 0 && feederHit(feeder, context) !== null) {
      return message(command, feeder.join(" "), `xargs ${call.program}`);
    }
  }
  return null;
}
