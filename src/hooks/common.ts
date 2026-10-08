/**
 * Payload, path, and vault-root helpers shared by the hook events.
 *
 * Paths resolve symlinks component by component (`realpath` from the core),
 * so a symlinked `.agents/docs` folder or a relative patch path reaches the
 * vault file it names, even when the file does not exist yet. A hook never
 * lets a setup error block a tool call: an unconfigured vault reads as "no
 * vault".
 */

import { lstatSync, mkdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { vaultRoot } from "../root.ts";

const MAX_SYMLINKS = 40;

/**
 * Resolve symlinks and `..`, one component at a time with `lstat` and
 * `readlink`, so `link/..` leaves the link's target. Parts that do not exist
 * yet (a file a patch adds) are kept as written. This avoids `realpath(3)`,
 * which can block for seconds on an iCloud folder such as a synced vault.
 */
export function realpath(path: string): string {
  const pending = (path.startsWith("/") ? path : `${process.cwd()}/${path}`).split("/");
  let resolved = "";
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift() as string;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      resolved = resolved.slice(0, resolved.lastIndexOf("/"));
      continue;
    }
    const next = `${resolved}/${name}`;
    let target: string | null = null;
    try {
      if (links < MAX_SYMLINKS && lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
    } catch {}
    if (target === null) {
      resolved = next;
      continue;
    }
    links++;
    if (target.startsWith("/")) resolved = "";
    pending.unshift(...target.split("/"));
  }
  return resolved || "/";
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A UTF-8 text file with `\r\n` and `\r` read as `\n`. Invalid UTF-8 throws
 * a `TypeError`, a missing file an OS error.
 */
export function readText(path: string): string {
  return UTF8.decode(readFileSync(path)).replace(/\r\n?/g, "\n");
}

export type Payload = Record<string, unknown>;

/** The collection the stamp hook marks dirty and the stop hook reindexes. */
export const COLLECTION = "llmos";

export function isDict(value: unknown): value is Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether a JSON value is set: not `null`, `false`, `0`, `""`, `[]`, or `{}`. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** The first set value, else `fallback`. */
export function firstTruthy(values: unknown[], fallback: unknown): unknown {
  for (const value of values) if (truthy(value)) return value;
  return fallback;
}

/** The JSON object on stdin, or `{}` when stdin is not a JSON object. */
export async function readPayload(): Promise<Payload> {
  try {
    const data: unknown = JSON.parse(await Bun.stdin.text());
    return isDict(data) ? data : {};
  } catch {
    return {};
  }
}

/** The payload's `session_id`, or "default". */
export function sessionId(data: Payload): string {
  const id = data.session_id;
  return typeof id === "string" && id ? id : "default";
}

/** `~` and `~/...` expanded with `$HOME`. */
export function expandUser(path: string): string {
  const home = (process.env.HOME ?? homedir()).replace(/\/+$/, "");
  if (path === "~") return home || "/";
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** Join path names without folding `..`, so symlinks resolve before `..`. */
export function joinPath(base: string, ...names: string[]): string {
  let path = base;
  for (const name of names) {
    if (name.startsWith("/")) path = name;
    else path = path.endsWith("/") ? `${path}${name}` : `${path}/${name}`;
  }
  return path;
}

/** The lower-case extension of a path (".md"), or "". */
export function suffix(path: string): string {
  return extname(path).toLowerCase();
}

/** Whether `path` is `root` or inside it; both resolved and absolute. */
export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether `error` came from a system call, not from decoding. */
export function isOSError(error: unknown): boolean {
  return error instanceof Error && "syscall" in error;
}

/**
 * Resolve a payload path: expand `~`, anchor a relative path at the payload
 * `cwd` (else the process cwd), and resolve symlinks. Blank or non-string
 * values give `null`.
 */
export function pathFrom(value: unknown, cwd?: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let path = expandUser(value);
  if (!path.startsWith("/")) {
    const base = typeof cwd === "string" && cwd ? expandUser(cwd) : process.cwd();
    path = joinPath(base, path);
  }
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

/** The configured llmOS root, resolved, or `null` when it is not configured or invalid. */
export function resolvedRoot(): string | null {
  try {
    return realpath(vaultRoot());
  } catch {
    return null;
  }
}

/** Today's local date as `YYYY-MM-DD`. */
export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The session-scoped dirty flag that the stamp hook sets and the stop hook
 * clears: `<tmpdir>/llmos-hooks/<session>/<collection>.dirty`. Scoping by
 * session keeps concurrent sessions from sharing a stale flag.
 */
export function flagPath(session: string, collection: string): string {
  const scratch = join(tmpdir(), "llmos-hooks", session);
  mkdirSync(scratch, { recursive: true });
  return join(scratch, `${collection}.dirty`);
}
