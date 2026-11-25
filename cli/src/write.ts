/**
 * Headless note writes: every content and property change is an atomic file
 * write through the one frontmatter serializer (`frontmatter.ts`), so it
 * works with Obsidian closed. Only `move` and `create --template` call
 * obsidian-cli (`obsidian.ts`), because only the app rewrites backlinks and
 * expands templates.
 *
 * Every function takes the vault root and a vault-relative path. A write
 * lands only inside the vault: the path may not be absolute or climb out
 * with `..`, and its real path (every symbolic link in it resolved) must be
 * inside the real vault root. So a symlinked note or folder that points
 * inside the vault is written through, and one that points outside is
 * refused (`WriteRefused`). The temporary file lives in the real target's
 * folder, so the final rename never crosses folders.
 *
 * A function that reads a note, changes it, and writes it back does that under
 * the vault's note lock (`withNoteLock`), so two writers at once, in any
 * process, never lose each other's change. Obsidian takes no lock.
 *
 * Each function reads the note again just before writing it. A note whose
 * frontmatter block cannot be read is never rewritten
 * (`UnsupportedFrontmatter`). A note without a block gets one only when a
 * property is set; appending text leaves it without one.
 *
 * Every write sets the dirty flag (`dirty.ts`), so the Stop hook reindexes.
 */

import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative as relativePath } from "node:path";
import { bodyWithThought } from "./daily.ts";
import { markDirty } from "./dirty.ts";
import { Frontmatter, MissingFrontmatter } from "./frontmatter.ts";
import { LockRefused, vaultLockPath, waitLock } from "./lock.ts";
import { LINK_FIELDS } from "./schema.ts";
import {
  insideVault,
  readText,
  resolveInVault,
  type VaultFile,
  WriteRefused,
  within,
} from "./vault-file.ts";

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real path a file at `relative` would get: the longest part of it that
 * exists (the file itself, or a symbolic link there, or its nearest existing
 * folder) resolved, refused unless that is inside the real vault root. A
 * dangling link is refused.
 */
export function newTarget(root: string, relative: string): string {
  const absolute = insideVault(root, relative);
  let existing = absolute;
  while (!present(existing)) existing = dirname(existing);
  let resolved: string;
  try {
    resolved = realpathSync(existing);
  } catch {
    throw new WriteRefused(`'${relative}' is a link to nothing`);
  }
  const real = join(resolved, relativePath(existing, absolute));
  if (!within(realpathSync(root), real)) {
    throw new WriteRefused(`'${relative}' resolves to ${real}, which is outside the vault`);
  }
  return real;
}

function writeTemporary(folder: string, name: string, text: string, mode: number): string {
  const temporary = join(folder, `.${name}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temporary, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  return temporary;
}

/**
 * Replace the file at real path `real`, in the vault at `root`, with `text`
 * atomically: write a temporary file beside it, then rename it over the
 * original. The file keeps its permission bits.
 */
function atomicReplace(root: string, real: VaultFile, text: string): void {
  const mode = statSync(real).mode & 0o7777;
  const temporary = writeTemporary(dirname(real), basename(real), text, mode);
  try {
    renameSync(temporary, real);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  markDirty(root);
}

/** Create the note at `relative` with `text`, atomically; refuse if anything is there. */
export function createNote(root: string, relative: string, text: string): void {
  const real = newTarget(root, relative);
  mkdirSync(dirname(real), { recursive: true });
  const temporary = writeTemporary(dirname(real), basename(real), text, 0o644);
  try {
    linkSync(temporary, real);
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") {
      throw new WriteRefused(`a file already exists at ${relative}`);
    }
    throw error;
  } finally {
    unlinkSync(temporary);
  }
  markDirty(root);
}

/** Write `text` to the note at `relative` atomically: replace it, or create it when missing. */
export function writeNote(root: string, relative: string, text: string): void {
  if (!present(insideVault(root, relative))) {
    createNote(root, relative, text);
    return;
  }
  atomicReplace(root, resolveInVault(root, relative), text);
}

/** Delete the note at `relative`; refused when it is missing or outside the vault. */
export function deleteNote(root: string, relative: string): void {
  if (!present(insideVault(root, relative))) {
    throw new WriteRefused(`no file at ${relative}`);
  }
  unlinkSync(resolveInVault(root, relative));
  markDirty(root);
}

const NOTE_LOCK_WAIT_MS = 10_000;

/**
 * Run `work` while no other read-change-write of a note in the vault at
 * `root` runs, in this or another process: it holds one kernel lock per vault
 * (`vaultLockPath`) and waits up to `waitMs` for it. A write holds it for
 * milliseconds. Never hold it across a slow call such as a model call.
 */
export function withNoteLock<T>(root: string, work: () => T, waitMs = NOTE_LOCK_WAIT_MS): T {
  let held: ReturnType<typeof waitLock>;
  try {
    held = waitLock(vaultLockPath(root, "notes", realpathSync(root), process.env), waitMs);
  } catch (error) {
    if (error instanceof LockRefused) throw new WriteRefused(error.message);
    throw error;
  }
  if (held === null) {
    throw new WriteRefused(`another note write held the vault lock for ${waitMs / 1000} s`);
  }
  try {
    return work();
  } finally {
    held.release();
  }
}

/** The note's frontmatter, or an empty block when the note has none. */
function frontmatterOf(text: string): Frontmatter {
  try {
    return Frontmatter.parse(text);
  } catch (error) {
    if (error instanceof MissingFrontmatter) return Frontmatter.create({}, text);
    throw error;
  }
}

/**
 * Replace the note's whole text with `rewrite(text)` under the note lock.
 * Writes only when the text changes; returns whether it wrote.
 */
export function rewriteNote(
  root: string,
  relative: string,
  rewrite: (text: string) => string,
): boolean {
  return withNoteLock(root, () => {
    const real = resolveInVault(root, relative);
    const text = readText(real);
    const rewritten = rewrite(text);
    if (rewritten === text) return false;
    atomicReplace(root, real, rewritten);
    return true;
  });
}

/** Rewrite a note with its body changed by `edit`; a note without a block stays without one. */
function editBody(root: string, relative: string, edit: (body: string) => string): void {
  withNoteLock(root, () => {
    const real = resolveInVault(root, relative);
    const text = readText(real);
    let frontmatter: Frontmatter;
    try {
      frontmatter = Frontmatter.parse(text);
    } catch (error) {
      if (!(error instanceof MissingFrontmatter)) throw error;
      const edited = edit(text);
      atomicReplace(root, real, edited.endsWith("\n") ? edited : `${edited}\n`);
      return;
    }
    frontmatter.body = edit(frontmatter.body);
    atomicReplace(root, real, frontmatter.toString());
  });
}

const LIST_PROPERTIES = new Set<string>(LINK_FIELDS);

/**
 * Set property `key` to `value`. The schema's list properties (the link
 * fields) are append-only: the value is added to the list unless it
 * is already there.
 */
export function setProperty(root: string, relative: string, key: string, value: string): void {
  withNoteLock(root, () => {
    const real = resolveInVault(root, relative);
    const frontmatter = frontmatterOf(readText(real));
    if (LIST_PROPERTIES.has(key)) frontmatter.appendUnique(key, value);
    else frontmatter.setScalar(key, value);
    atomicReplace(root, real, frontmatter.toString());
  });
}

/**
 * Record a run on a note in one edit and one atomic write: set `key` and
 * `updated` to `date`, as `stampNote` does. With `dryRun` nothing is
 * written: it throws exactly when the real call would, so a caller can check
 * before it does any work.
 */
export function recordRun(
  root: string,
  relative: string,
  key: string,
  date: string,
  dryRun = false,
): void {
  const edit = (): void => {
    const real = resolveInVault(root, relative);
    const frontmatter = frontmatterOf(readText(real));
    frontmatter.setScalar(key, date);
    frontmatter.setScalar("updated", date);
    const text = frontmatter.toString();
    if (!dryRun) atomicReplace(root, real, text);
  };
  if (dryRun) edit();
  else withNoteLock(root, edit);
}

/** Remove property `key`. Returns false (and writes nothing) when the note has no such property. */
export function removeProperty(root: string, relative: string, key: string): boolean {
  return withNoteLock(root, () => {
    const real = resolveInVault(root, relative);
    const frontmatter = frontmatterOf(readText(real));
    if (!frontmatter.delete(key)) return false;
    atomicReplace(root, real, frontmatter.toString());
    return true;
  });
}

export function appendContent(root: string, relative: string, content: string): void {
  editBody(root, relative, (body) =>
    body === "" ? content : `${body.replace(/\n+$/, "")}\n${content}`,
  );
}

/**
 * Add `thought` as a paragraph under the daily note's `## Thoughts` heading.
 * Everything from the `llmos-activity` start marker onward is kept (see
 * `bodyWithThought`); like every write, the note is saved in canonical form,
 * which trims trailing whitespace from body lines but keeps hard line breaks.
 */
export function appendThought(root: string, relative: string, thought: string): void {
  editBody(root, relative, (body) => bodyWithThought(body, thought));
}

/**
 * Stamp a note as the PostToolUse hook stamps a `Write`: `updated` set to
 * `date`. A note without a frontmatter block is left as it is. Returns
 * whether it wrote.
 */
export function stampNote(root: string, relative: string, date: string): boolean {
  return withNoteLock(root, () => {
    const real = resolveInVault(root, relative);
    const text = readText(real);
    let frontmatter: Frontmatter;
    try {
      frontmatter = Frontmatter.parse(text);
    } catch (error) {
      if (error instanceof MissingFrontmatter) return false;
      throw error;
    }
    frontmatter.setScalar("updated", date);
    const stamped = frontmatter.toString();
    if (stamped === text) return false;
    atomicReplace(root, real, stamped);
    return true;
  });
}

/**
 * Add each property in `stamps` that the note does not have yet. Writes only
 * when something changes; returns whether it wrote.
 */
export function stampProperties(
  root: string,
  relative: string,
  stamps: Record<string, string[]>,
): boolean {
  return withNoteLock(root, () => {
    const real = resolveInVault(root, relative);
    const frontmatter = frontmatterOf(readText(real));
    const current = frontmatter.properties;
    let changed = false;
    for (const [key, values] of Object.entries(stamps)) {
      if (key in current) continue;
      for (const value of values) frontmatter.appendUnique(key, value);
      changed = true;
    }
    if (changed) atomicReplace(root, real, frontmatter.toString());
    return changed;
  });
}
