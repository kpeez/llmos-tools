/**
 * PostToolUse: normalize and stamp vault notes, then report authoring
 * findings.
 *
 * For each Markdown note the tool wrote under the vault root, it writes the
 * canonical frontmatter with `updated` set to today and the invoking
 * provider appended to `authors` once, then flags the qmd collection dirty
 * for the stop hook. A note without a frontmatter block, with a block the
 * serializer refuses to rewrite, or with invalid UTF-8 is left unchanged.
 * Findings are informational: they never block the write or change the
 * note.
 */

import { closeSync, existsSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { checkNote } from "../authoring.ts";
import { Frontmatter } from "../frontmatter.ts";
import { detectProvider } from "../provider.ts";
import { type Note, type NoteSource, readSource, readText, VaultModel } from "../vault.ts";
import {
  COLLECTION,
  flagPath,
  isFile,
  isUnder,
  localDate,
  type Payload,
  realpath,
  resolvedRoot,
  sessionId,
  suffix,
} from "./common.ts";
import { targetPaths, toolInputOf } from "./context.ts";

const MAX_FINDINGS = 8;
const MAX_LINE = 240;

/**
 * Stamp one note. Returns whether it is in stamped canonical form now;
 * `false` means it was left unchanged because it has no frontmatter block,
 * the serializer refused to rewrite it, or it is not valid UTF-8.
 */
export function stampNote(path: string, provider: string | null, date = localDate()): boolean {
  let text: string;
  let stamped: string;
  try {
    text = readText(path);
    const frontmatter = Frontmatter.parse(text).setScalar("updated", date);
    if (provider) frontmatter.appendUnique("authors", provider);
    stamped = frontmatter.toString();
  } catch {
    return false;
  }
  // In place, like the Python hook: a replacing rename would drop the file's
  // birth time (Obsidian's created time), extended attributes, and hard links.
  if (stamped !== text) writeFileSync(path, stamped);
  return true;
}

interface Listed {
  path: string;
  name: string;
  symlink: boolean;
}

/** Paths matching `**\/*.md` under `root`, outside `.obsidian/`, without following folder symlinks. */
async function scan(root: string, onlyFiles: boolean): Promise<string[]> {
  const found: string[] = [];
  const glob = new Bun.Glob("**/*.md");
  for await (const path of glob.scan({ cwd: root, dot: true, onlyFiles, followSymlinks: false })) {
    if (!path.split("/").includes(".obsidian")) found.push(path);
  }
  return found;
}

/**
 * Every `.md` file or file symlink under `root` outside `.obsidian/`, as
 * `walkMarkdown` finds them: folder symlinks are not followed, so a symlink
 * cycle or an outside folder never enters the index. The scans run on Bun's
 * thread pool, so they overlap with the stamp. `onlyFiles` leaves out
 * symlinks; the few extra entries of the full scan are checked with `lstat`.
 */
async function listNotes(root: string): Promise<Listed[]> {
  const [files, all] = await Promise.all([scan(root, true), scan(root, false)]);
  const regular = new Set(files);
  const found: Listed[] = files.map((path) => ({ path, name: basename(path), symlink: false }));
  for (const path of all) {
    if (regular.has(path)) continue;
    try {
      if (lstatSync(join(root, path)).isSymbolicLink()) {
        found.push({ path, name: basename(path), symlink: true });
      }
    } catch {}
  }
  return found;
}

/**
 * A vault model with the note paths the authoring check can need, reading
 * only `paths`, so a hook never reads the whole vault. Like
 * `VaultModel.load`, it leaves out `.md` symlinks whose target is missing.
 *
 * A finding's target is a note whose file name the checked text mentions
 * (matched without case), or the target of a `.md` symlink. Other notes
 * cannot change a finding, so they are left out to keep the model small.
 */
function modelFor(root: string, listed: Listed[], paths: string[]): VaultModel {
  const checked = new Set(paths);
  const mentioned = paths.map((path) => readText(join(root, path)).toLowerCase()).join("\n");
  const notes: Listed[] = [];
  const symlinkTargets = new Set<string>();
  for (const note of listed) {
    if (note.symlink) {
      const target = realpath(join(root, note.path));
      if (!existsSync(target)) continue;
      if (isUnder(target, root)) symlinkTargets.add(target.slice(root.length + 1));
    }
    notes.push(note);
  }
  const sources: NoteSource[] = [];
  for (const { path, name, symlink } of notes) {
    if (checked.has(path)) {
      sources.push(readSource(path, readText(join(root, path))));
    } else if (symlink || symlinkTargets.has(path) || mentioned.includes(name.toLowerCase())) {
      sources.push({ path, text: "", properties: {}, body: "", hasFrontmatter: false });
    }
  }
  return VaultModel.fromSources(root, sources);
}

function noteAt(model: VaultModel, root: string, relative: string): Note {
  const found = model.notes.find((note) => note.path === relative);
  if (found) return found;
  // A note outside the walk (inside `.obsidian/`) is still checked by path.
  const source = readSource(relative, readText(join(root, relative)));
  return { ...source, name: basename(relative, ".md"), targets: [] };
}

function collapseWhitespace(text: string): string {
  return text.trim().split(/\s+/).join(" ");
}

/** Whether a note mentions `.md`, which every authoring finding needs. */
function mayHaveFindings(path: string): boolean {
  try {
    return readText(path).includes(".md");
  } catch {
    return false;
  }
}

/** Concise authoring findings for the notes, or `null`. Never edits or blocks. */
function authoringDiagnostics(root: string, paths: string[], listed: Listed[]): string | null {
  const lines: string[] = [];
  try {
    const relatives = paths.map((path) => path.slice(root.length + 1));
    const model = modelFor(root, listed, relatives);
    outer: for (const relative of relatives) {
      const check = checkNote(model, noteAt(model, root, relative));
      for (const finding of check.findings) {
        const location = finding.line ? `:${finding.line}` : "";
        const target = finding.target ? ` -> ${finding.target}` : "";
        let line = `${check.path}${location} [${finding.code}]${target}: ${collapseWhitespace(finding.message)}`;
        if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE - 3).trimEnd()}...`;
        lines.push(line);
        if (lines.length >= MAX_FINDINGS) break outer;
      }
    }
  } catch {
    return null;
  }
  if (lines.length === 0) return null;
  return (
    "llmOS authoring check (informational; this checker did not block the " +
    "write or rewrite note content):\n" +
    lines.join("\n") +
    "\nRun `llmos-vault check <note>` for complete findings."
  );
}

export async function postToolUse(data: Payload): Promise<string | null> {
  const root = resolvedRoot();
  if (root === null) return null;
  const toolInput = toolInputOf(data);
  if (toolInput === null) return null;
  const toolName = typeof data.tool_name === "string" ? data.tool_name : "";
  const targets = targetPaths(toolInput, { cwd: data.cwd, toolName, root }).filter(
    (target) => isUnder(target, root) && suffix(target) === ".md" && isFile(target),
  );
  if (targets.length === 0) return null;
  // List the vault only when a note could have findings (the listing is the
  // slowest part of this hook), and start it before stamping so it overlaps.
  const checked = targets.filter(mayHaveFindings);
  const listing = checked.length > 0 ? listNotes(root).catch(() => null) : null;
  const provider = detectProvider(process.env);
  let stamped = false;
  for (const target of targets) {
    if (stampNote(target, provider)) stamped = true;
  }
  if (stamped) closeSync(openSync(flagPath(sessionId(data), COLLECTION), "a"));
  const listed = await listing;
  return listed ? authoringDiagnostics(root, checked, listed) : null;
}
