/**
 * Read-only, conservative checks for connections missing from note prose.
 *
 * This is an authoring aid, not an Obsidian renderer or a general Markdown
 * validator. Only an explicit `.md` reference that resolves to an existing
 * note earns a finding. Concepts, link quotas, and unresolved future notes
 * need the author's judgment.
 */

import { lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { blankCodeSpans, codeSpans } from "./code-spans.ts";
import { RAW_DIR } from "./layout.ts";
import { markdownFindings } from "./markdown-lint.ts";
import { extractWikilinks, type Note, propertyLinks, type VaultModel } from "./vault.ts";

// A word character in any script, so note names need not be ASCII (`\w` is).
const W = "\\p{L}\\p{N}_";
const WIKI = /!?\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_LINK = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
const NOTE_PATH = new RegExp(`(?<![${W}/\\\\.:])(?:[${W}.-]+/)*[${W}.-]+\\.md(?![${W}])`, "gu");
const CODE_PATH = new RegExp(`^[${W} .\\-/]+\\.md$`, "u");
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const COMMENTS = /<!--[\s\S]*?-->|%%[\s\S]*?%%/g;
const URL = new RegExp(`(?<![${W}])[a-zA-Z][${W}+.-]*://[^\\s<>]+`, "gu");
const SCHEME = new RegExp(`^[a-zA-Z][${W}+.-]*:`, "u");

export interface Finding {
  code: string;
  line: number;
  target: string;
  message: string;
}

export interface NoteCheck {
  path: string;
  body_links: string[];
  property_links: string[];
  findings: Finding[];
}

/** Replace every character except line breaks with a space, keeping offsets. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/** A line with each tab expanded to the next multiple of 4 columns, as Markdown reads indents. */
function expandTabs(line: string): string {
  let out = "";
  for (const char of line) out += char === "\t" ? " ".repeat(4 - (out.length % 4)) : char;
  return out;
}

/** Hide code examples and comments while keeping offsets for line numbers. */
function prose(body: string): string {
  const result: string[] = [];
  let fence: string | null = null;
  const listContentIndents: number[] = [];
  // Each line keeps its "\n", so joining the results keeps every offset.
  for (const line of body.split(/(?<=\n)/)) {
    const expanded = expandTabs(line);
    const indent = expanded.length - expanded.trimStart().length;
    const item = LIST_ITEM.exec(expanded);
    if (line.trim() && fence === null) {
      while (listContentIndents.length > 0 && indent < (listContentIndents.at(-1) as number)) {
        listContentIndents.pop();
      }
    }
    const nestedItem =
      item !== null &&
      listContentIndents.length > 0 &&
      indent < (listContentIndents.at(-1) as number) + 4;
    const match = FENCE.exec(line);
    if (fence !== null) {
      result.push(blank(line));
      const marker = match?.[1];
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
    } else if (match) {
      fence = match[1] as string;
      result.push(blank(line));
    } else if (indent >= 4 && !nestedItem) {
      result.push(blank(line));
    } else {
      result.push(line);
      if (item) listContentIndents.push(item[0].length);
    }
  }
  return result.join("").replace(COMMENTS, (m) => blank(m));
}

/** Decode %XX escapes as UTF-8, replacing invalid sequences, as `urllib.parse.unquote` does. */
function unquote(value: string): string {
  if (!value.includes("%")) return value;
  return value.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  });
}

function bodyLinks(text: string): string[] {
  const visible = blankCodeSpans(text);
  const targets = extractWikilinks(visible);
  for (const match of visible.matchAll(MARKDOWN_LINK)) {
    const destination = ((match[1] as string).trim().split(" ", 1)[0] as string).replace(
      /^[<>]+|[<>]+$/g,
      "",
    );
    if (SCHEME.test(destination)) continue;
    const target = unquote(destination).split("#", 1)[0] as string;
    if (target.endsWith(".md")) targets.push(target.slice(0, -3));
  }
  return [...new Set(targets)].sort();
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve symlinks and `..` component by component, as Python's
 * `os.path.realpath` does. Unlike the native call, it keeps the letter case
 * the caller gave, so a case-insensitive file system cannot change a match.
 */
export function realpath(path: string): string {
  const seen = new Map<string, string | null>();
  const joinReal = (start: string, rest: string): [string, boolean] => {
    let current = start;
    let remaining = rest;
    if (isAbsolute(remaining)) {
      remaining = remaining.slice(1);
      current = sep;
    }
    while (remaining) {
      const slash = remaining.indexOf(sep);
      const name = slash === -1 ? remaining : remaining.slice(0, slash);
      remaining = slash === -1 ? "" : remaining.slice(slash + 1);
      if (!name || name === ".") continue;
      if (name === "..") {
        if (current) {
          const cut = current.lastIndexOf(sep);
          const tail = current.slice(cut + 1);
          current = cut <= 0 ? current.slice(0, cut + 1) : current.slice(0, cut);
          if (tail === "..") current = join(current, "..", "..");
        } else current = "..";
        continue;
      }
      const next = current ? join(current, name) : name;
      if (!isSymlink(next)) {
        current = next;
        continue;
      }
      if (seen.has(next)) {
        const known = seen.get(next);
        if (known != null) {
          current = known;
          continue;
        }
        return [join(next, remaining), false];
      }
      seen.set(next, null);
      const [resolved, ok] = joinReal(current, readlinkSync(next));
      if (!ok) return [join(resolved, remaining), false];
      current = resolved;
      seen.set(next, resolved);
    }
    return [current, true];
  };
  const [resolved] = joinReal("", path);
  return isAbsolute(resolved) ? resolved : resolvePath(resolved);
}

/** Resolve a local or vault path first; only a unique basename may fall back. */
function existingNote(
  model: VaultModel,
  root: string,
  source: Note,
  reference: string,
): Note | undefined {
  const folder = dirname(source.path);
  for (const base of [folder === "." ? root : `${root}/${folder}`, root]) {
    // No lexical `..` folding first: `realpath` resolves symlinks before `..`.
    const candidate = realpath(isAbsolute(reference) ? reference : `${base}/${reference}`);
    if (candidate.startsWith(root + sep)) {
      const relative = candidate.slice(root.length + 1);
      const note = model.notes.find((n) => n.path === relative);
      if (note) return note;
    }
  }
  if (reference.includes("/") || reference.includes("\\")) return undefined;
  const key = (reference.endsWith(".md") ? reference.slice(0, -3) : reference).toLowerCase();
  const matches = model.notes.filter((n) => n.name.toLowerCase() === key);
  return matches.length === 1 ? matches[0] : undefined;
}

function countNewlines(text: string): number {
  let n = 0;
  for (const char of text) if (char === "\n") n++;
  return n;
}

/**
 * Check explicit note references in one note and separate prose links from
 * property links. Findings ask for review; they never rewrite notes.
 *
 * Like the Python checker, it works on the resolved file: a symlinked note
 * is checked as its target, and a target outside the vault throws.
 */
export function checkNote(model: VaultModel, linked: Note): NoteCheck {
  const root = realpath(model.root);
  const real = realpath(model.absolutePath(linked));
  if (!real.startsWith(root + sep)) {
    throw new Error(`not a Markdown note in this vault: ${model.absolutePath(linked)}`);
  }
  const relative = real.slice(root.length + 1);
  const target = model.notes.find((n) => n.path === relative);
  const note: Note = target ?? { ...linked, path: relative };
  const lineOffset = countNewlines(note.text.slice(0, note.text.length - note.body.length));
  const visible = prose(note.body);
  const propertyTargets = [...new Set(propertyLinks(note.properties))].sort();

  const candidates: [number, string][] = [];
  // Existing links are not missing navigation, whatever their style.
  let unlinked = visible.replace(WIKI, (m) => blank(m));
  unlinked = unlinked.replace(MARKDOWN_LINK, (m) => blank(m));
  unlinked = unlinked.replace(URL, (m) => blank(m));
  for (const span of codeSpans(unlinked)) {
    const literal = span.content.trim();
    if (CODE_PATH.test(literal)) candidates.push([span.start, literal]);
  }
  unlinked = blankCodeSpans(unlinked);
  for (const match of unlinked.matchAll(NOTE_PATH)) candidates.push([match.index, match[0]]);
  candidates.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const seen = new Set<Note>();
  const findings: Finding[] = [];
  for (const [offset, reference] of candidates) {
    const target = existingNote(model, root, note, reference);
    if (target === undefined || target === note || seen.has(target)) continue;
    seen.add(target);
    const targetName = target.path.slice(0, -3);
    findings.push({
      code: "unlinked-note",
      line: lineOffset + countNewlines(note.body.slice(0, offset)) + 1,
      target: targetName,
      message:
        `Existing note reference ${JSON.stringify(reference)}: link to ${JSON.stringify(targetName)} ` +
        "using the note title or a natural phrase, not the filename.",
    });
  }
  // Raw material is never restyled: captures are frozen and hash-checked, and
  // drops await ingest. Dot folders are not notes.
  if (
    !note.path.split("/").some((part, i) => part.startsWith(".") || (i === 0 && part === RAW_DIR))
  ) {
    for (const found of markdownFindings(note.text)) findings.push({ ...found, target: "" });
  }
  return {
    path: note.path,
    body_links: bodyLinks(visible),
    property_links: propertyTargets,
    findings,
  };
}
