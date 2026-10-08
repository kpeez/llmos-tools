/**
 * One in-memory model of a vault, read straight off disk (works with
 * Obsidian closed).
 *
 * `VaultModel.load` reads every `.md` note once (skipping `.obsidian/`) and
 * keeps its properties, body, outgoing wikilinks (from the body, then from
 * property values), and forward and backward edges. Every read and graph
 * query answers from this model instead of re-reading files.
 *
 * Name resolution follows Obsidian's order: an exact vault-relative path,
 * then the only note with that basename (case-insensitive), then the match in
 * the linking note's own folder, then the match with the strictly shortest
 * path. A name typed by a caller fails with the candidates listed when it is
 * ambiguous; a link inside content stays unresolved instead.
 */

import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import {
  MissingFrontmatter,
  type Properties,
  type PropertyValue,
  readLenient,
  UnsupportedFrontmatter,
} from "./frontmatter.ts";

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** One note file as read from disk. */
export interface NoteSource {
  /** Vault-relative path with `/` separators, including `.md`. */
  readonly path: string;
  /** The file text, with `\r\n` and `\r` read as `\n`. */
  readonly text: string;
  readonly properties: Properties;
  readonly body: string;
  /** Whether the text starts with a closed `---` frontmatter block. */
  readonly hasFrontmatter: boolean;
  /** Why the frontmatter block could not be read, when it exists but is unsupported. */
  readonly frontmatterError?: UnsupportedFrontmatter;
}

export interface Note extends NoteSource {
  /** The file name without `.md`. */
  readonly name: string;
  /** Raw wikilink targets: body links first, then property links in property order. */
  readonly targets: readonly string[];
}

/** A `.md` symbolic link whose target does not exist. */
export interface BrokenLink {
  readonly path: string;
  readonly target: string;
}

export interface NoteRecord {
  name: string;
  path: string;
  properties: Properties;
  body: string;
}

export interface Neighbors {
  note: string;
  outgoing: string[];
  unresolved_outgoing: string[];
  backlinks: string[];
  topic_siblings: string[];
}

export type EdgeKind = "link" | "topic_sibling";

export interface Subgraph {
  root: string;
  nodes: string[];
  unresolved: string[];
  edges: [string, string, EdgeKind][];
}

export interface UnresolvedLink {
  referrer: string;
  target: string;
}

export interface LinkFindings {
  orphans: string[];
  dead_ends: string[];
  unresolved_links: UnresolvedLink[];
}

export class NoteNotFoundError extends Error {
  override name = "NoteNotFoundError";
}

export class AmbiguousNoteError extends Error {
  override name = "AmbiguousNoteError";
  constructor(
    message: string,
    readonly candidates: string[],
  ) {
    super(message);
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Read a file the way Python's text mode does: `\r\n` and `\r` become `\n`,
 * a byte-order mark is kept, and invalid UTF-8 throws (a `TypeError`), so a
 * later rewrite can never replace undecodable bytes.
 */
export function readText(path: string): string {
  return UTF8.decode(readFileSync(path)).replace(/\r\n?/g, "\n");
}

/**
 * Raw wikilink targets in `text`, with `#heading` and `|alias` removed.
 * Inside Markdown tables Obsidian requires the alias separator to be
 * escaped as `\|`; the backslash belongs to the separator, not the name.
 */
export function extractWikilinks(text: string): string[] {
  const found: string[] = [];
  for (const match of text.replaceAll("\\|", "|").matchAll(WIKILINK)) {
    found.push((match[1] as string).trim());
  }
  return found;
}

function* strings(value: PropertyValue): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else for (const item of Object.values(value)) yield* strings(item);
}

/** Every wikilink target inside property values (nested ones too), in property order. */
export function propertyLinks(properties: Properties): string[] {
  const found: string[] = [];
  for (const value of Object.values(properties)) {
    for (const text of strings(value)) found.push(...extractWikilinks(text));
  }
  return found;
}

/** Read one note file; an unreadable frontmatter block reads as no properties. */
export function readSource(path: string, text: string): NoteSource {
  const { properties, body, error } = readLenient(text);
  return {
    path,
    text,
    properties,
    body,
    hasFrontmatter: !(error instanceof MissingFrontmatter),
    ...(error instanceof UnsupportedFrontmatter ? { frontmatterError: error } : {}),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Path order: vault-relative paths compared folder by folder, so the notes
 * of `a/` sort before `a-b.md`. Comparing the strings with `/` read as the
 * lowest character is the same as comparing them component by component.
 */
export function comparePaths(a: string, b: string): number {
  return compare(a.replaceAll("/", "\0"), b.replaceAll("/", "\0"));
}

/** Vault-relative paths of every `.md` file, outside any `.obsidian` folder, in path order. */
export function walkMarkdown(root: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (entry.name === ".obsidian") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
        found.push(path);
      }
    }
  };
  visit("");
  return found.sort(comparePaths);
}

function stemKey(target: string): string {
  return (target.endsWith(".md") ? target.slice(0, -3) : target).toLowerCase();
}

/** The `topics` strings of a note: a list's string items, or a single non-empty string. */
function topicsOf(note: Note): Set<string> {
  const topics = note.properties.topics;
  if (Array.isArray(topics)) {
    return new Set(topics.filter((topic): topic is string => typeof topic === "string"));
  }
  return typeof topics === "string" && topics ? new Set([topics]) : new Set();
}

export class VaultModel {
  readonly notes: readonly Note[];
  private readonly byPath = new Map<string, Note>();
  private readonly byStem = new Map<string, Note[]>();
  /** The root with one trailing `/`, the prefix of an absolute note path. */
  private readonly rootPrefix: string;
  /** Per note: the resolved target of each raw target (undefined when unresolved). */
  private readonly resolved = new Map<Note, (Note | undefined)[]>();
  /** Per note: the other notes whose links resolve to it. */
  private readonly linkedFrom = new Map<Note, Set<Note>>();
  private readonly topics = new Map<Note, Set<string>>();
  private readonly notesByTopic = new Map<string, Note[]>();

  private constructor(
    readonly root: string,
    notes: Note[],
    readonly brokenLinks: readonly BrokenLink[],
  ) {
    this.notes = notes;
    this.rootPrefix = join(root, "/");
    for (const note of notes) {
      this.byPath.set(note.path, note);
      const key = note.name.toLowerCase();
      const group = this.byStem.get(key);
      if (group) group.push(note);
      else this.byStem.set(key, [note]);
    }
    for (const note of notes) {
      this.linkedFrom.set(note, new Set());
      const topics = topicsOf(note);
      this.topics.set(note, topics);
      for (const topic of topics) {
        const group = this.notesByTopic.get(topic);
        if (group) group.push(note);
        else this.notesByTopic.set(topic, [note]);
      }
    }
    for (const note of notes) {
      const hits = note.targets.map((target) => this.resolveLink(target, note));
      this.resolved.set(note, hits);
      for (const hit of hits) {
        if (hit !== undefined && hit !== note) this.linkedFrom.get(hit)?.add(note);
      }
    }
  }

  /**
   * Read every note under `root` once. A `.md` symbolic link whose target is
   * missing is listed in `brokenLinks` instead of failing the load.
   */
  static load(root: string): VaultModel {
    const sources: NoteSource[] = [];
    const broken: BrokenLink[] = [];
    for (const path of walkMarkdown(root)) {
      const absolute = join(root, path);
      if (!existsSync(absolute)) {
        broken.push({ path, target: readlinkSync(absolute) });
        continue;
      }
      sources.push(readSource(path, readText(absolute)));
    }
    return VaultModel.fromSources(root, sources, broken);
  }

  /** Build the model from notes already read, in path order. */
  static fromSources(
    root: string,
    sources: readonly NoteSource[],
    brokenLinks: readonly BrokenLink[] = [],
  ): VaultModel {
    const notes = sources.map(
      (source): Note => ({
        ...source,
        name: basename(source.path, ".md"),
        targets: [...extractWikilinks(source.body), ...propertyLinks(source.properties)],
      }),
    );
    return new VaultModel(root, notes, brokenLinks);
  }

  /** The note's path joined to the vault root. */
  absolutePath(note: Note): string {
    return join(this.root, note.path);
  }

  /**
   * The note at an exact path `<stem>.md`, if one exists: vault-relative, or
   * absolute under the root. The path is normalized first (`./`, `//`, `..`).
   */
  private directPath(target: string, allowRoot: boolean): Note | undefined {
    const base = target.endsWith(".md") ? target.slice(0, -3) : target;
    if (!base.includes("/") && !allowRoot) return undefined;
    const path = normalize(`${base}.md`);
    if (!path.startsWith("/")) return this.byPath.get(path);
    if (!path.startsWith(this.rootPrefix)) return undefined;
    return this.byPath.get(path.slice(this.rootPrefix.length));
  }

  /**
   * Resolve a note name or path typed by a caller to exactly one note.
   * An exact vault-relative path wins even without a slash, so a root-level
   * note stays addressable when a nested note shares its name.
   */
  resolveNote(target: string): Note {
    const direct = this.directPath(target, true);
    if (direct) return direct;
    const matches = this.byStem.get(stemKey(target)) ?? [];
    if (matches.length === 0) {
      throw new NoteNotFoundError(`no note named '${target}' found in vault '${this.root}'`);
    }
    if (matches.length > 1) {
      const candidates = matches.map((note) => note.path);
      throw new AmbiguousNoteError(
        `'${target}' is ambiguous, matches: ${candidates.join(", ")}`,
        candidates,
      );
    }
    return matches[0] as Note;
  }

  /** Resolve a wikilink found in vault content; ambiguous or missing targets are undefined. */
  resolveLink(target: string, source?: Note): Note | undefined {
    const direct = this.directPath(target, false);
    if (direct) return direct;
    const matches = this.byStem.get(stemKey(target)) ?? [];
    if (matches.length <= 1) return matches[0];
    if (source) {
      const folder = dirname(source.path);
      const sameFolder = matches.filter((note) => dirname(note.path) === folder);
      if (sameFolder.length === 1) return sameFolder[0];
    }
    const lengths = matches.map((note) => note.path.length).sort((a, b) => a - b);
    const shortest = lengths[0] as number;
    if (shortest === lengths[1]) return undefined;
    return matches.find((note) => note.path.length === shortest);
  }

  private outgoing(note: Note): { resolved: Note[]; unresolved: string[] } {
    const resolved: Note[] = [];
    const unresolved: string[] = [];
    const hits = this.resolved.get(note) ?? [];
    note.targets.forEach((target, i) => {
      const hit = hits[i];
      if (hit === undefined) unresolved.push(target);
      else if (hit !== note) resolved.push(hit);
    });
    return { resolved, unresolved };
  }

  private backlinks(note: Note): Set<Note> {
    return this.linkedFrom.get(note) ?? new Set();
  }

  private topicSiblings(note: Note): Set<Note> {
    const siblings = new Set<Note>();
    for (const topic of this.topics.get(note) ?? []) {
      for (const other of this.notesByTopic.get(topic) ?? []) {
        if (other !== note) siblings.add(other);
      }
    }
    return siblings;
  }

  private record(note: Note): NoteRecord {
    return {
      name: note.name,
      path: this.absolutePath(note),
      properties: note.properties,
      body: note.body,
    };
  }

  /**
   * One note's properties and body. A block that cannot be represented reads
   * as no properties plus the body after the block; with `strict` it throws
   * `UnsupportedFrontmatter` instead. Every caller that writes properties
   * back must pass `strict`, or it would overwrite values it never saw.
   */
  read(name: string, options: { strict?: boolean } = {}): NoteRecord {
    const note = this.resolveNote(name);
    if (options.strict && note.frontmatterError) throw note.frontmatterError;
    return this.record(note);
  }

  /** Every note in path order; an unsupported block reads as no properties. */
  list(): NoteRecord[] {
    return this.notes.map((note) => this.record(note));
  }

  neighbors(name: string): Neighbors {
    const note = this.resolveNote(name);
    const { resolved, unresolved } = this.outgoing(note);
    return {
      note: note.name,
      outgoing: [...new Set(resolved.map((n) => n.name))].sort(),
      unresolved_outgoing: [...new Set(unresolved)].sort(),
      backlinks: [...new Set([...this.backlinks(note)].map((n) => n.name))].sort(),
      topic_siblings: [...new Set([...this.topicSiblings(note)].map((n) => n.name))].sort(),
    };
  }

  /** The neighborhood out to `depth` hops over links, backlinks, and shared topics. */
  subgraph(name: string, depth = 1): Subgraph {
    const root = this.resolveNote(name);
    const visited = new Set<Note>([root]);
    let frontier = new Set<Note>([root]);
    const edges = new Map<string, [string, string, EdgeKind]>();
    const unresolved = new Set<string>();
    const addEdge = (edge: [string, string, EdgeKind]): void => {
      edges.set(JSON.stringify(edge), edge);
    };

    for (let hop = 0; hop < depth; hop++) {
      const next = new Set<Note>();
      for (const note of frontier) {
        const outgoing = this.outgoing(note);
        for (const target of outgoing.unresolved) unresolved.add(target);
        for (const target of outgoing.resolved) {
          addEdge([note.name, target.name, "link"]);
          if (!visited.has(target)) next.add(target);
        }
        for (const source of this.backlinks(note)) {
          addEdge([source.name, note.name, "link"]);
          if (!visited.has(source)) next.add(source);
        }
        for (const sibling of this.topicSiblings(note)) {
          const [first, second] = [note.name, sibling.name].sort() as [string, string];
          addEdge([first, second, "topic_sibling"]);
          if (!visited.has(sibling)) next.add(sibling);
        }
      }
      if (next.size === 0) break;
      for (const note of next) visited.add(note);
      frontier = next;
    }

    return {
      root: root.name,
      nodes: [...visited].map((note) => note.name).sort(),
      unresolved: [...unresolved].sort(),
      edges: [...edges.values()].sort(
        (a, b) => compare(a[0], b[0]) || compare(a[1], b[1]) || compare(a[2], b[2]),
      ),
    };
  }

  /** Orphans (no inbound links), dead-ends (no outgoing links), and unresolved links. */
  linkFindings(): LinkFindings {
    const linkedTo = new Set<Note>();
    const unresolved: UnresolvedLink[] = [];
    for (const note of this.notes) {
      const hits = this.resolved.get(note) ?? [];
      note.targets.forEach((target, i) => {
        const hit = hits[i];
        if (hit === undefined) unresolved.push({ referrer: note.name, target });
        else if (hit !== note) linkedTo.add(hit);
      });
    }
    return {
      orphans: this.notes
        .filter((n) => !linkedTo.has(n))
        .map((n) => n.name)
        .sort(),
      dead_ends: this.notes
        .filter((n) => n.targets.length === 0)
        .map((n) => n.name)
        .sort(),
      unresolved_links: unresolved.sort(
        (a, b) => compare(a.referrer, b.referrer) || compare(a.target, b.target),
      ),
    };
  }
}
