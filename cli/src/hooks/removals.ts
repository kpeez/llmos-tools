/**
 * The after-shell check: tell the agent which vault notes a shell command
 * removed or moved. The guard (`guard.ts`) reads the text of a command before
 * it runs and misses a form it cannot parse (`find -delete`, `bash -c`, a
 * wrapper). This check reads the vault after the command, so it sees the
 * result whatever the form.
 *
 * Each session keeps a list of the vault's notes (`notes/<vault hash>-<session
 * hash>` in the llmOS state folder). Session start writes it. After every shell
 * call the check lists the vault again, reports each listed note that is gone,
 * and saves the new list. The report names the note, says that a raw move or
 * delete breaks links, and says how to undo it. It never restores a note: a
 * restore writes to the vault and could replace an edit made since.
 *
 * It cannot tell who removed a note. A note that another session, the
 * Obsidian app, or a `git pull` removed between two checks looks the same.
 * It leaves out a note whose path or name the command text names beside
 * `obsidian-cli` or `llmos`: that is a removal through the supported tools.
 *
 * Notes never listed (made and removed between two checks, outside a Write or
 * Edit that `recordNotes` saw) are never reported. A vault that holds no `.md`
 * file reports nothing. Antigravity cannot inject text after a tool, so its
 * report waits in a pending file that the next `pre-tool-use` hands over.
 */

import {
  closeSync,
  constants,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { readNoFollow, safeFolder } from "../dirty.ts";
import { stateDir } from "../heartbeat.ts";
import { firstTruthy, type Payload, realpath } from "./common.ts";

const MAX_LISTED = 10;
const STALE_MS = 14 * 24 * 3600 * 1000;
const TOOLED = /\b(?:obsidian-cli|llmos)\b/;

/** One name per session: the harness's session id, or one shared name when it sends none. */
export function sessionKey(raw: Payload): string {
  const id = firstTruthy([raw.session_id, raw.conversationId], "shared");
  return typeof id === "string" ? id : "shared";
}

function stateFile(root: string, session: string, suffix = ""): string {
  const hash = (text: string) =>
    new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
  const name = `${hash(realpath(root))}-${hash(session)}${suffix}`;
  return join(stateDir(process.env), "notes", name);
}

/** Every `.md` file under `root` outside dot folders, relative; symbolic-link folders are not followed. */
function listNotes(root: string): string[] {
  const found: string[] = [];
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(`${folder}/${entry.name}`, `${relative}/`);
      else if (entry.name.endsWith(".md")) found.push(relative);
    }
  };
  walk(root, "");
  return found;
}

function save(file: string, text: string): void {
  const temporary = join(safeFolder(file), `.${process.pid}.${crypto.randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function load(file: string): string[] | null {
  try {
    return readNoFollow(file).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

function pruneStale(file: string): void {
  const folder = dirname(file);
  for (const name of readdirSync(folder)) {
    if (name.startsWith(".")) continue;
    try {
      if (Date.now() - statSync(join(folder, name)).mtimeMs > STALE_MS) {
        rmSync(join(folder, name), { force: true });
      }
    } catch {}
  }
}

/** Save the list of the vault's notes for this session; call at session start. */
export function startNoteWatch(root: string, raw: Payload): void {
  const file = stateFile(root, sessionKey(raw));
  save(file, listNotes(root).join("\n"));
  pruneStale(file);
}

/** Add notes a Write or Edit made to the session's list, so a later removal is seen. */
export function recordNotes(root: string, raw: Payload, absolutePaths: string[]): void {
  const file = stateFile(root, sessionKey(raw));
  const known = load(file);
  if (known === null) return;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const added = absolutePaths
    .filter((path) => path.startsWith(prefix) && path.endsWith(".md"))
    .map((path) => path.slice(prefix.length))
    .filter((relative) => !relative.split("/").some((part) => part.startsWith(".")));
  const merged = new Set([...known, ...added]);
  if (merged.size !== known.length) save(file, [...merged].join("\n"));
}

function named(command: string, note: string): boolean {
  const stem = basename(note, ".md");
  return command.includes(note) || command.includes(stem);
}

function render(root: string, gone: string[], present: string[]): string {
  const byName = new Map<string, string>();
  for (const path of present) byName.set(basename(path), path);
  const lines = gone.slice(0, MAX_LISTED).map((path) => {
    const moved = byName.get(basename(path));
    return moved ? `- ${path} (now at ${moved})` : `- ${path}`;
  });
  if (gone.length > MAX_LISTED) lines.push(`- and ${gone.length - MAX_LISTED} more`);
  return [
    `llmOS vault check: ${gone.length} vault note(s) are gone from their path since the last shell call:`,
    ...lines,
    "A raw move or delete does not rewrite the links to a note, so those links break.",
    "To undo it now: for a note that git tracks, run " +
      `\`git -C ${root} restore -- <path>\`; for a move, run ` +
      "`obsidian-cli move file=<name> to=<old path>` to move it back. " +
      "Git cannot restore a note that was never committed.",
    "If you did not run this command (another session, the Obsidian app, or a git sync may have removed the note), ignore this message.",
    "Use `obsidian-cli move` or `obsidian-cli delete` for a vault note.",
  ].join("\n");
}

/**
 * The report for the notes that `command` removed, or `null`. Always saves the
 * new list, so a removal is reported once. With no saved list (session start
 * did not run), it saves one and reports nothing.
 */
export function checkRemovals(root: string, raw: Payload, command: string): string | null {
  const file = stateFile(root, sessionKey(raw));
  const before = load(file);
  const present = listNotes(root);
  const now = new Set(present);
  if (before !== null && before.length === now.size && before.every((path) => now.has(path))) {
    return null;
  }
  save(file, present.join("\n"));
  if (before === null) return null;
  let gone = before.filter((path) => !now.has(path));
  if (TOOLED.test(command)) gone = gone.filter((path) => !named(command, path));
  return gone.length > 0 ? render(root, gone, present) : null;
}

/** Keep a report for the next `pre-tool-use` (Antigravity has no channel after a tool). */
export function holdReport(root: string, raw: Payload, report: string): void {
  save(stateFile(root, sessionKey(raw), ".pending"), report);
}

/** The held report of this session, removed as it is read. */
export function takeReport(root: string, raw: Payload): string | null {
  const file = stateFile(root, sessionKey(raw), ".pending");
  try {
    const report = readNoFollow(file);
    rmSync(file, { force: true });
    return report;
  } catch {
    return null;
  }
}
