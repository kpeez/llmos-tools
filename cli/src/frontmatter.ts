/**
 * The one canonical YAML-frontmatter reader and writer for the vault.
 *
 * A note's frontmatter is the text between a first line `---` and the next
 * line `---`. It is parsed with the `yaml` package's Document API, with the
 * failsafe schema, so every scalar reads as a string: `count: 3` reads as
 * "3" and `flag: true` as "true". A block with YAML errors or warnings, a
 * block that is not a map, a property without a value, or an empty list item
 * (core YAML reads both as null) throws `UnsupportedFrontmatter`, and a
 * caller that writes notes must then leave the note untouched.
 *
 * `Frontmatter.toString` writes the canonical form:
 *
 * - top-level keys sorted by code point, with no blank lines between them;
 * - a property whose value is a single-line string, or a list of non-empty
 *   single-line strings, written the way the retired Python serializer wrote it:
 *   `key:` for an empty string, `key: []` for an empty list, block-style list
 *   items, and a value double-quoted only when bare YAML would read it
 *   differently (so wikilinks are always quoted). A value that was quoted in
 *   the source and that YAML 1.1 or 1.2 would read as a null, bool, or
 *   number stays quoted, so its type does not change for other readers;
 * - any other property (block scalars, nested maps, anchors, tags, comments
 *   inside the value) kept byte for byte from the source, or, after a
 *   change, written by the `yaml` package;
 * - comments before a key kept above that key; one blank line after the
 *   closing `---`; one final newline;
 * - no trailing whitespace on body lines, except a Markdown hard line break:
 *   a line with content that ends in two or more spaces keeps that run of
 *   spaces (and loses any other whitespace before it). A single trailing
 *   space, trailing tabs, and lines of only whitespace are still trimmed.
 *
 * Before it returns, `toString` parses its own output and refuses (throws
 * `UnsupportedFrontmatter`) unless it reads back as the current values,
 * every property that was not set keeps its parsed value, every parsed
 * comment is still there, and a second normalization gives the same text.
 * A change that replaces or removes a value moves that value's comments
 * above a property, and a value that holds a YAML anchor is never replaced.
 */

import { isDeepStrictEqual } from "node:util";
import {
  Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node,
  Pair,
  parseDocument,
  Scalar,
  visit,
  YAMLMap,
  type YAMLSeq,
} from "yaml";

export type PropertyValue = string | PropertyValue[] | { [key: string]: PropertyValue };
export type Properties = Record<string, PropertyValue>;

export interface Parsed {
  properties: Properties;
  body: string;
}

/** The text has no `---`-delimited frontmatter block at all. */
export class MissingFrontmatter extends Error {
  override name = "MissingFrontmatter";
}

/** The block is not valid YAML properties, or cannot be rewritten without changing it. */
export class UnsupportedFrontmatter extends Error {
  override name = "UnsupportedFrontmatter";
}

/**
 * The block is not valid YAML: the parser reports an error or a warning. This is
 * the one refusal that other YAML readers, such as a static-site build, also
 * fail on. `line` and `column` count from 1, from the first line after the
 * opening `---`.
 */
export class InvalidYamlFrontmatter extends UnsupportedFrontmatter {
  // Same name as the parent: the error name is part of the contract snapshots.
  override name = "UnsupportedFrontmatter";
  constructor(
    readonly detail: string,
    readonly line: number,
    readonly column: number,
    message: string,
  ) {
    super(message);
  }
}

/** A change to a property that must never change (`created`). */
export class ImmutableProperty extends Error {
  override name = "ImmutableProperty";
}

const OPEN = "---\n";
const CLOSE = "\n---\n";
const PARSE_OPTIONS = { schema: "failsafe", uniqueKeys: true } as const;
const STRINGIFY_OPTIONS = {
  indent: 2,
  indentSeq: true,
  lineWidth: 0,
  minContentWidth: 0,
  flowCollectionPadding: false,
} as const;

// A plain scalar may not start with a YAML indicator, and ": " or " #"
// inside one ends it early. Such a value is written double-quoted.
const YAML_INDICATORS = "[]{}&*!|>'\"%@`#,?:";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const UNREPRESENTABLE = /[\x00-\x1f\x7f\x85\u2028\u2029]/;
// Text that bare YAML (1.2 core, or 1.1 as PyYAML reads it) would read as a
// null, a bool, or a number. Dates are left alone: YAML 1.2 reads a bare date
// as a string.
const TYPED_LOOKING = new RegExp(
  "^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE" +
    "|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF" +
    "|[-+]?[0-9][0-9_]*|[-+]?0o[0-7_]+|[-+]?0x[0-9a-fA-F_]+|[-+]?0b[01_]+" +
    "|[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+(\\.[0-9_]*)?" +
    "|[-+]?(\\.[0-9_]+|[0-9][0-9_]*(\\.[0-9_]*)?)([eE][-+]?[0-9]+)?" +
    "|[-+]?\\.(inf|Inf|INF)|\\.(nan|NaN|NAN))$",
);

// The canonical form is an on-disk contract that the Python serializer
// defined, so its text rules keep Python's character sets rather than
// JavaScript's: whitespace as `str.strip` sees it (with \x1c-\x1f and \x85,
// without U+FEFF, unlike `trim`), the line breaks `str.splitlines` splits
// on, and key order by code point (not UTF-16 code unit).
const WHITESPACE = new Set(
  "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005" +
    "\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000",
);
// biome-ignore lint/suspicious/noControlCharactersInRegex: these control characters are line breaks.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function rstrip(value: string): string {
  let end = value.length;
  while (end > 0 && WHITESPACE.has(value[end - 1] as string)) end--;
  return value.slice(0, end);
}

function strip(value: string): string {
  let start = 0;
  while (start < value.length && WHITESPACE.has(value[start] as string)) start++;
  return rstrip(value.slice(start));
}

function byCodePoint(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done || q.done) return p.done ? (q.done ? 0 : -1) : 1;
    const diff = (p.value.codePointAt(0) as number) - (q.value.codePointAt(0) as number);
    if (diff !== 0) return diff;
  }
}

function needsQuotes(value: string): boolean {
  return (
    value === "" ||
    YAML_INDICATORS.includes(value[0] as string) ||
    value.startsWith("- ") ||
    value === "-" ||
    value.endsWith(":") ||
    value !== strip(value) ||
    value.includes(": ") ||
    value.includes(" #")
  );
}

function doubleQuoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function isQuoted(node: Scalar): boolean {
  return node.type === Scalar.QUOTE_DOUBLE || node.type === Scalar.QUOTE_SINGLE;
}

/** A single-line string scalar with no anchor, tag, or comment. */
function isSimpleScalar(node: unknown): node is Scalar<string> {
  return (
    isScalar(node) &&
    typeof node.value === "string" &&
    (node.type === undefined || node.type === Scalar.PLAIN || isQuoted(node)) &&
    !node.anchor &&
    !node.tag &&
    !node.comment &&
    !node.commentBefore &&
    !UNREPRESENTABLE.test(node.value)
  );
}

/** A key the Python serializer could write bare. A comment above it is written separately. */
function isSimpleKey(node: unknown): node is Scalar<string> {
  if (!isScalar(node)) return false;
  const { commentBefore } = node;
  node.commentBefore = undefined;
  try {
    return (
      isSimpleScalar(node) &&
      !needsQuotes(node.value) &&
      !node.value.includes(":") &&
      !(isQuoted(node) && TYPED_LOOKING.test(node.value))
    );
  } finally {
    node.commentBefore = commentBefore;
  }
}

/** Write a string scalar the way the Python serializer did, keeping quotes that carry a type. */
function renderScalar(node: Scalar<string>): string {
  const value = node.value;
  if (isQuoted(node) && (value === "" || TYPED_LOOKING.test(value))) return doubleQuoted(value);
  return needsQuotes(value) ? doubleQuoted(value) : value;
}

/** Lines for a property the Python serializer could write, or null if it could not. */
function simpleLines(pair: Pair): string[] | null {
  const { key, value } = pair;
  if (!isSimpleKey(key)) return null;
  if (isSimpleScalar(value)) {
    if (value.value === "" && !isQuoted(value)) return [`${key.value}:`];
    return [`${key.value}: ${renderScalar(value)}`];
  }
  if (
    isSeq(value) &&
    !value.anchor &&
    !value.tag &&
    !value.comment &&
    !value.commentBefore &&
    value.items.every((item) => isSimpleScalar(item) && item.value !== "")
  ) {
    if (value.items.length === 0) return [`${key.value}: []`];
    const items = value.items as Scalar<string>[];
    return [`${key.value}:`, ...items.map((item) => `  - ${renderScalar(item)}`)];
  }
  return null;
}

/** The property's source text, when it starts a line and can move as a unit. */
function sourceLines(pair: Pair, source: string): string[] | null {
  const key = pair.key as Scalar;
  const value = pair.value as Node | null;
  const start = key.range?.[0];
  const end = (value ?? key).range?.[2];
  if (start === undefined || end === undefined) return null;
  if (start !== 0 && source[start - 1] !== "\n") return null;
  const text = source.slice(start, end);
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  // Trailing spaces are content only inside a block scalar.
  let hasBlockScalar = false;
  if (value)
    visit(value, (_key, node) => {
      if (
        isScalar(node) &&
        (node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED)
      ) {
        hasBlockScalar = true;
      }
    });
  return hasBlockScalar ? lines : lines.map((line) => rstrip(line));
}

/** The property written by the `yaml` package, without the comment above its key. */
function yamlLines(pair: Pair): string[] {
  const key = pair.key as Scalar;
  const { commentBefore, spaceBefore } = key;
  key.commentBefore = undefined;
  key.spaceBefore = undefined;
  try {
    const doc = new Document(null, PARSE_OPTIONS);
    const map = new YAMLMap();
    map.items.push(pair);
    doc.contents = map;
    const text = doc.toString(STRINGIFY_OPTIONS);
    return text
      .replace(/\n+$/, "")
      .split("\n")
      .filter((line, i) => i > 0 || line !== "");
  } catch (error) {
    throw new UnsupportedFrontmatter(
      `cannot write property ${JSON.stringify(key.value)}: ${String(error)}`,
    );
  } finally {
    key.commentBefore = commentBefore;
    key.spaceBefore = spaceBefore;
  }
}

function commentLines(comment: string | null | undefined): string[] {
  if (!comment) return [];
  return comment
    .split("\n")
    .filter((line) => strip(line) !== "")
    .map((line) => rstrip(`#${line}`));
}

function keyOf(pair: Pair): string {
  return (pair.key as Scalar<string>).value;
}

/**
 * The canonical lines between the `---` markers. `source` is the parsed
 * block text, or null when the document was built in memory; properties
 * named in `changed` are never copied from the source.
 */
function blockLines(doc: Document, source: string | null, changed: ReadonlySet<string>): string[] {
  const lines = commentLines(doc.commentBefore);
  const map = doc.contents;
  if (isMap(map)) {
    lines.push(...commentLines(map.commentBefore));
    const pairs = [...(map.items as Pair[])].sort((a, b) => byCodePoint(keyOf(a), keyOf(b)));
    for (const pair of pairs) {
      lines.push(...commentLines((pair.key as Scalar).commentBefore));
      const verbatim =
        source !== null && !changed.has(keyOf(pair)) ? sourceLines(pair, source) : null;
      lines.push(...(simpleLines(pair) ?? verbatim ?? yamlLines(pair)));
    }
    lines.push(...commentLines(map.comment));
  }
  lines.push(...commentLines(doc.comment));
  return lines;
}

/** Every comment line in a document, as written, in sorted order. */
function comments(doc: Document): string[] {
  const found = [...commentLines(doc.commentBefore), ...commentLines(doc.comment)];
  visit(doc, (_key, node) => {
    if (isNode(node))
      found.push(...commentLines(node.commentBefore), ...commentLines(node.comment));
  });
  return found.sort();
}

/**
 * Why plain values cannot be written, or null. A missing value or an empty
 * list item reads as a null in core YAML (Obsidian's reading), so neither is
 * accepted; an empty property (`key:`) is.
 */
function invalidValue(value: unknown): string | null {
  if (value === null || value === undefined) return "a property or list item has no value";
  if (Array.isArray(value)) {
    if (value.some((item) => item === "")) return "a list item is empty";
    for (const item of value) {
      const reason = invalidValue(item);
      if (reason) return reason;
    }
  } else if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const reason = invalidValue(item);
      if (reason) return reason;
    }
  }
  return null;
}

/** Every comment in a node and its children, removed from them. */
function detachComments(node: unknown): string[] {
  const found: string[] = [];
  const take = (item: unknown): void => {
    if (!isNode(item)) return;
    if (item.commentBefore) found.push(item.commentBefore);
    if (item.comment) found.push(item.comment);
    item.commentBefore = undefined;
    item.comment = undefined;
  };
  take(node);
  if (isNode(node)) visit(node, (_key, item) => take(item));
  return found;
}

/** Refuse to replace or remove a node that an alias may point at. */
function assertNoAnchor(key: string, node: unknown): void {
  let anchored = isNode(node) && Boolean(node.anchor);
  if (isNode(node)) {
    visit(node, (_key, item) => {
      if (isNode(item) && item.anchor) anchored = true;
    });
  }
  if (anchored) {
    throw new UnsupportedFrontmatter(
      `property ${JSON.stringify(key)} holds a YAML anchor; refusing to replace or remove it`,
    );
  }
}

function addCommentBefore(node: Scalar, comments: string[]): void {
  const all = [...comments, node.commentBefore].filter((text): text is string => Boolean(text));
  node.commentBefore = all.length > 0 ? all.join("\n") : undefined;
}

/** The document's properties as plain values. */
function toProperties(doc: Document): Properties {
  return (doc.toJS({ maxAliasCount: -1 }) ?? {}) as Properties;
}

/** Parse a frontmatter block, or throw `UnsupportedFrontmatter`. */
function parseBlock(source: string): Document.Parsed {
  const doc = parseDocument(source, PARSE_OPTIONS);
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    const first = problem.message.split("\n")[0] as string;
    const [at] = problem.linePos ?? [{ line: 1, col: 1 }];
    throw new InvalidYamlFrontmatter(
      first.replace(/ at line \d+, column \d+:?$/, ""),
      at.line,
      at.col,
      `frontmatter is not valid YAML (${problem.code}: ${first})`,
    );
  }
  const map = doc.contents;
  if (map !== null && !isMap(map)) {
    throw new UnsupportedFrontmatter("frontmatter is not a map of properties");
  }
  if (map !== null) {
    for (const pair of map.items as Pair[]) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new UnsupportedFrontmatter("frontmatter has a property name that is not a string");
      }
    }
  }
  const invalid = invalidValue(toProperties(doc));
  if (invalid) throw new UnsupportedFrontmatter(`frontmatter is not supported: ${invalid}`);
  return doc;
}

/**
 * Split off the frontmatter block, or throw `MissingFrontmatter`. An empty
 * block (`---` then `---`) counts as a block, so the canonical form of a note
 * with no properties reads back as frontmatter. (The Python reader saw no
 * block there, so normalizing such a note twice failed.)
 */
function split(text: string): { block: string; body: string } {
  if (!text.startsWith(OPEN)) {
    throw new MissingFrontmatter("note has no frontmatter block (must start with '---')");
  }
  const end = text.startsWith(`${OPEN}---\n`) ? OPEN.length - 1 : text.indexOf(CLOSE, OPEN.length);
  if (end === -1) {
    throw new MissingFrontmatter("note's frontmatter block is never closed with '---'");
  }
  return {
    block: text.slice(OPEN.length, end),
    body: text.slice(end + CLOSE.length).replace(/^\n+/, ""),
  };
}

/**
 * A body line without trailing whitespace, except that a line with content
 * keeps a final run of two or more spaces: CommonMark reads that run as a
 * hard line break. Tabs and a single space never make one.
 */
function bodyLine(line: string): string {
  const content = rstrip(line);
  if (content === "") return "";
  return content + (/ {2,}$/.exec(line)?.[0] ?? "");
}

/** The canonical note text for frontmatter lines and a body. */
function assemble(lines: string[], body: string): string {
  const bodyLines = body.split(LINE_BREAK).map(bodyLine);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  // Reading drops leading blank lines, so writing one would not be idempotent.
  while (bodyLines.length > 0 && bodyLines[0] === "") bodyLines.shift();
  return `${["---", ...lines, "---", "", ...bodyLines].join("\n")}\n`;
}

/**
 * A note's parsed frontmatter and body, for reading properties and for
 * writing the note back in canonical form.
 */
export class Frontmatter {
  private readonly changed = new Set<string>();
  private readonly original: Properties;
  private readonly originalComments: string[];

  private constructor(
    private readonly doc: Document,
    private readonly source: string | null,
    /** The note text after the frontmatter block, without leading blank lines. */
    public body: string,
  ) {
    this.original = toProperties(doc);
    this.originalComments = comments(doc);
  }

  /** Parse a note. Throws `MissingFrontmatter` or `UnsupportedFrontmatter`. */
  static parse(text: string): Frontmatter {
    const { block, body } = split(text);
    const source = `${block}\n`;
    return new Frontmatter(parseBlock(source), source, body);
  }

  /** A new note from plain properties and a body. */
  static create(properties: Properties, body: string): Frontmatter {
    const doc = new Document(properties, PARSE_OPTIONS);
    return new Frontmatter(doc, null, body);
  }

  /** The properties as plain values: strings, lists, and maps. */
  get properties(): Properties {
    return toProperties(this.doc);
  }

  private map(): YAMLMap {
    if (this.doc.contents === null) this.doc.contents = new YAMLMap();
    return this.doc.contents as YAMLMap;
  }

  private pair(key: string): Pair | undefined {
    return (this.map().items as Pair[]).find((pair) => keyOf(pair) === key);
  }

  /** Set a property to a string. `created` never changes. */
  setScalar(key: string, value: string): this {
    if (key === "created") {
      throw new ImmutableProperty("created is immutable and is never rewritten");
    }
    const pair = this.pair(key);
    assertNoAnchor(key, pair?.value);
    const scalar = new Scalar(value);
    if (pair === undefined) {
      this.map().items.push(new Pair(new Scalar(key), scalar));
    } else {
      // A new node, so an anchor on the old one never carries the new value
      // to its aliases. A comment on the old value stays with the property.
      if (isScalar(pair.value)) {
        scalar.comment = pair.value.comment;
        pair.value.comment = undefined;
      }
      addCommentBefore(pair.key as Scalar, detachComments(pair.value));
      pair.value = scalar;
    }
    this.changed.add(key);
    return this;
  }

  /**
   * Set `key` to a string inside the map property `parent`, adding the map
   * when it is missing; a new key goes first. The map's other entries keep
   * their nodes, so their quoting and comments survive. Throws
   * `UnsupportedFrontmatter` when `parent` holds something other than a map.
   */
  setInMap(parent: string, key: string, value: string): this {
    if (parent === "created") {
      throw new ImmutableProperty("created is immutable and is never rewritten");
    }
    const pair = this.pair(parent);
    if (pair === undefined) {
      this.map().items.push(new Pair(new Scalar(parent), this.doc.createNode({ [key]: value })));
    } else if (isMap(pair.value)) {
      const map = pair.value as YAMLMap;
      const inner = (map.items as Pair[]).find((item) => keyOf(item) === key);
      if (inner === undefined) {
        map.items.unshift(new Pair(new Scalar(key), new Scalar(value)));
      } else {
        assertNoAnchor(`${parent}.${key}`, inner.value);
        inner.value = new Scalar(value);
      }
    } else {
      throw new UnsupportedFrontmatter(`property ${JSON.stringify(parent)} is not a map`);
    }
    this.changed.add(parent);
    return this;
  }

  /**
   * Add `value` to the list property `key` unless it is already there. A
   * string property becomes a list that keeps the string; an empty string
   * counts as no value.
   */
  appendUnique(key: string, value: string): this {
    if (key === "created") {
      throw new ImmutableProperty("created is immutable and is never rewritten");
    }
    const pair = this.pair(key);
    if (pair === undefined) {
      this.map().items.push(new Pair(new Scalar(key), this.doc.createNode([value])));
    } else if (isSeq(pair.value)) {
      const seq = pair.value as YAMLSeq;
      const present = seq.items.some((item) => isScalar(item) && item.value === value);
      if (!present) seq.items.push(new Scalar(value));
    } else if (isScalar(pair.value) && typeof pair.value.value === "string") {
      assertNoAnchor(key, pair.value);
      const current = pair.value.value;
      const values = current === "" || current === value ? [value] : [current, value];
      addCommentBefore(pair.key as Scalar, detachComments(pair.value));
      pair.value = this.doc.createNode(values);
    } else {
      throw new UnsupportedFrontmatter(`property ${JSON.stringify(key)} is not a list`);
    }
    this.changed.add(key);
    return this;
  }

  /**
   * Remove a property. `created` never changes. Comments on the removed
   * property move above the next property. Returns whether it existed.
   */
  delete(key: string): boolean {
    if (key === "created") {
      throw new ImmutableProperty("created is immutable and is never rewritten");
    }
    const map = this.map();
    const index = (map.items as Pair[]).findIndex((pair) => keyOf(pair) === key);
    if (index === -1) return false;
    assertNoAnchor(key, (map.items[index] as Pair).value);
    const [removed] = map.items.splice(index, 1) as Pair[];
    const moved = [...detachComments(removed?.key), ...detachComments(removed?.value)];
    const next = map.items[index] as Pair | undefined;
    if (next) addCommentBefore(next.key as Scalar, moved);
    else if (moved.length > 0) map.comment = [map.comment, ...moved].filter(Boolean).join("\n");
    this.changed.add(key);
    return true;
  }

  /**
   * The note in canonical form. Throws `UnsupportedFrontmatter` when the
   * output would not read back as the current values, would change a
   * property that was not set, would lose a comment, or would change again
   * on a second normalization.
   */
  toString(): string {
    const refuse = (reason: string): never => {
      throw new UnsupportedFrontmatter(`refusing to rewrite frontmatter: ${reason}`);
    };
    let current: Properties = {};
    try {
      current = this.properties;
    } catch (error) {
      refuse(`the properties do not resolve (${String(error)})`);
    }
    const invalid = invalidValue(current);
    if (invalid) refuse(invalid);
    const lines = blockLines(this.doc, this.source, this.changed);
    const written = `${lines.join("\n")}\n`;
    const reread = parseDocument(written, PARSE_OPTIONS);
    if (reread.errors.length > 0 || reread.warnings.length > 0) {
      refuse("the output is not valid YAML");
    }
    let rereadProperties: Properties = {};
    try {
      rereadProperties = toProperties(reread);
    } catch (error) {
      refuse(`the output does not read back (${String(error)})`);
    }
    if (!isDeepStrictEqual(rereadProperties, current)) refuse("a value would change");
    for (const [key, value] of Object.entries(this.original)) {
      if (!this.changed.has(key) && !isDeepStrictEqual(rereadProperties[key], value)) {
        refuse(`property ${JSON.stringify(key)} would change although it was not set`);
      }
    }
    if (!isDeepStrictEqual(comments(reread), this.originalComments)) {
      refuse("a comment would be lost");
    }
    if (blockLines(reread, written, new Set()).join("\n") !== lines.join("\n")) {
      refuse("the output would change again when normalized");
    }
    return assemble(lines, this.body);
  }
}

/**
 * Split `text` into properties and body. Throws `MissingFrontmatter` when
 * there is no `---` block and `UnsupportedFrontmatter` when the block is
 * not valid YAML properties.
 */
export function parse(text: string): Parsed {
  const frontmatter = Frontmatter.parse(text);
  return { properties: frontmatter.properties, body: frontmatter.body };
}

/**
 * Read a note for a read-only walk: a missing block gives no properties and
 * the full text as body; an unsupported block gives no properties and the
 * body after the block. Callers that write properties back must use `parse`.
 */
export function readLenient(
  text: string,
): Parsed & { error?: MissingFrontmatter | UnsupportedFrontmatter } {
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof MissingFrontmatter) return { properties: {}, body: text, error };
    if (error instanceof UnsupportedFrontmatter) {
      return { properties: {}, body: split(text).body, error };
    }
    throw error;
  }
}

/** Parse then re-serialize `text`. Idempotent; throws where `parse` or `toString` throws. */
export function normalize(text: string): string {
  return Frontmatter.parse(text).toString();
}

/** Render plain properties and a body as a canonical note. */
export function serialize(properties: Properties, body: string): string {
  return Frontmatter.create(properties, body).toString();
}
