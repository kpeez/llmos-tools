/**
 * Shared project memory (ADR-0020): `projects/<project>/memory/` holds a
 * `MEMORY.md` index of one-line links and one `<name>.md` topic note per
 * memory, in the format Claude Code writes through `autoMemoryDirectory`.
 * Claude Code, the session-start hook, the `llmos memory` verbs, the MCP
 * memory tools, and the Hermes memory provider all read and write this one
 * store.
 *
 * Every agent loads at most the first `MAX_INDEX_LINES` lines of the index,
 * so a save that would make the index longer fails instead of hiding the
 * newest lines. Writes go through `write.ts`, so they stay inside the vault.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Properties, parse, serialize } from "./frontmatter.ts";
import { MEMORY_DIR, MEMORY_INDEX } from "./layout.ts";
import { checkoutAt, projectSlug } from "./project.ts";
import { readText } from "./vault.ts";
import { deleteNote, WriteRefused, writeNote } from "./write.ts";

export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 25_000;
/** The project of a session with no vault project workspace. */
export const PERSONAL_PROJECT = "personal";
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

const INDEX_HEADER = "# Memory index\n";
const NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A memory request is invalid; nothing was written. */
export class MemoryRefused extends Error {
  override name = "MemoryRefused";
}

/** One project's memory folder and index, as vault-relative paths. */
export interface MemoryScope {
  project: string;
  dir: string;
  index: string;
}

export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** The index link text. Default: the name with spaces for its separators. */
  title?: string;
}

/** The memory scope of vault project `project`, which must exist under `projects/`. */
export function projectScope(root: string, project: string): MemoryScope {
  if (!PROJECT.test(project) || project.length > 100) {
    throw new MemoryRefused(`project must be a vault project folder name, got '${project}'`);
  }
  let isProject = false;
  try {
    isProject = statSync(join(root, "projects", project)).isDirectory();
  } catch {}
  if (!isProject) throw new MemoryRefused(`no vault project 'projects/${project}'`);
  const dir = `projects/${project}/${MEMORY_DIR}`;
  return { project, dir, index: `${dir}/${MEMORY_INDEX}` };
}

/**
 * The memory scope of a session in `workspace`: the vault project of its Git
 * repository (the session-start hook's rule), else `personal`.
 */
export function memoryScope(root: string, workspace: string | null): MemoryScope {
  const checkout = workspace === null ? null : checkoutAt(workspace);
  const slug = checkout === null ? null : projectSlug(checkout.main, root);
  return projectScope(root, slug ?? PERSONAL_PROJECT);
}

/**
 * The first `MAX_INDEX_LINES` lines and `MAX_INDEX_BYTES` UTF-8 bytes of the
 * index at absolute path `path`, marked when cut; `null` when it is missing
 * or empty.
 */
export function readMemoryIndex(path: string): string | null {
  let raw: string;
  try {
    raw = readText(path);
  } catch (error) {
    // A missing or unreadable index is no index; the session still starts.
    if ((error as { code?: unknown }).code !== undefined) return null;
    throw error;
  }
  const lines = raw.split("\n");
  let truncated = lines.length > MAX_INDEX_LINES;
  let text = truncated ? lines.slice(0, MAX_INDEX_LINES).join("\n") : raw;
  if (Buffer.byteLength(text, "utf8") > MAX_INDEX_BYTES) {
    truncated = true;
    let bytes = 0;
    let out = "";
    for (const ch of text) {
      const size = Buffer.byteLength(ch, "utf8");
      if (bytes + size > MAX_INDEX_BYTES) break;
      out += ch;
      bytes += size;
    }
    text = out;
  }
  const trimmed = text.trimEnd();
  if (!trimmed) return null;
  return truncated ? `${trimmed}\n[${MEMORY_INDEX} truncated]` : trimmed;
}

/** Whether index line `line` links to the note of memory `name`. */
function linksTo(line: string, name: string): boolean {
  return line.includes(`](${name}.md)`);
}

/**
 * `index` with the line for memory `name` replaced by `line`, or `line`
 * added at the end. Fails when the result is longer than `MAX_INDEX_LINES`.
 */
export function upsertIndexLine(index: string, name: string, line: string): string {
  const lines = (index.trimEnd() || INDEX_HEADER.trimEnd()).split("\n");
  const at = lines.findIndex((entry) => linksTo(entry, name));
  if (at >= 0) lines[at] = line;
  else {
    if (lines.length === 1) lines.push("");
    lines.push(line);
  }
  if (lines.length > MAX_INDEX_LINES) {
    throw new MemoryRefused(
      `${MEMORY_INDEX} would have ${lines.length} lines, more than the ${MAX_INDEX_LINES} ` +
        "that agents load; merge or forget memories first",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** `index` without the line for memory `name`. */
export function removeIndexLine(index: string, name: string): string {
  const lines = index.split("\n").filter((entry) => !linksTo(entry, name));
  return lines.join("\n");
}

function memoryName(name: string): string {
  if (!NAME.test(name) || name.length > 80) {
    throw new MemoryRefused(
      `name must be a lowercase slug of letters, digits, '-' and '_' (at most 80), got '${name}'`,
    );
  }
  return name;
}

function oneLine(field: string, value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL.test(trimmed)) {
    throw new MemoryRefused(`${field} must be one line of 1 to ${max} characters`);
  }
  return trimmed;
}

function memoryType(type: string): MemoryType {
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
    throw new MemoryRefused(`type must be one of ${MEMORY_TYPES.join(", ")}, got '${type}'`);
  }
  return type as MemoryType;
}

function existing(root: string, relative: string): string | null {
  const path = join(root, relative);
  return existsSync(path) ? readText(path) : null;
}

function defaultTitle(name: string): string {
  const words = name.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Write memory `input` as a topic note and its index line. A note that
 * exists keeps its other properties (such as Claude's `originSessionId`);
 * its body is replaced. The index is checked before anything is written.
 */
export function saveMemory(
  root: string,
  scope: MemoryScope,
  input: MemoryInput,
  now: Date,
): { path: string; index: string; created: boolean } {
  const name = memoryName(input.name);
  const description = oneLine("description", input.description, 300);
  const title = oneLine("title", input.title ?? defaultTitle(name), 120);
  const type = memoryType(input.type);
  const body = input.body.trim();
  if (!body) throw new MemoryRefused("body must not be empty");
  const path = `${scope.dir}/${name}.md`;

  const index = upsertIndexLine(
    existing(root, scope.index) ?? "",
    name,
    `- [${title}](${name}.md) — ${description}`,
  );
  const before = existing(root, path);
  const old: Properties = before === null ? {} : parse(before).properties;
  const oldMetadata = old.metadata;
  const metadata = {
    ...(oldMetadata && typeof oldMetadata === "object" && !Array.isArray(oldMetadata)
      ? oldMetadata
      : {}),
    node_type: "memory",
    type,
    modified: now.toISOString(),
  };
  const properties: Properties = { ...old, name, description, metadata };
  writeNote(root, path, serialize(properties, `\n${body}\n`));
  writeNote(root, scope.index, index);
  return { path, index: scope.index, created: before === null };
}

/** Delete memory `name`: its topic note and its index line. */
export function forgetMemory(
  root: string,
  scope: MemoryScope,
  name: string,
): { path: string; index: string } {
  const path = `${scope.dir}/${memoryName(name)}.md`;
  const index = existing(root, scope.index);
  const listed = (index ?? "").split("\n").some((line) => linksTo(line, name));
  const present = existing(root, path) !== null;
  if (!listed && !present) {
    throw new WriteRefused(`no memory named '${name}' in ${scope.dir}`);
  }
  if (listed && index !== null) writeNote(root, scope.index, removeIndexLine(index, name));
  if (present) deleteNote(root, path);
  return { path, index: scope.index };
}
