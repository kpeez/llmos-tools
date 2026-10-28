/**
 * Read-only check of the `[!fact]` and `[!conflict]` callouts in a note.
 *
 * A fact is a callout whose title is its status. It holds the fact text, one
 * nested quote, a final `— ` source line with a link to a heading of a
 * captured source, and, after one blank line, a `^fact-<slug>` block ID. The
 * lint checks that the quote occurs in the linked heading's section of the
 * source text and that every number in the fact occurs in the quote. The
 * format and the rules are in `llmOS/schema.md` (Compiled facts). The lint is necessary, not sufficient: it cannot see swapped
 * numbers, negation, or a real quote that does not support the fact.
 *
 * The lint returns a report and never prints or exits. A finding fails the
 * run; a flagged fact is reported and does not.
 */

import { createHash } from "node:crypto";
import { CAPTURE_NOTE } from "./layout.ts";
import type { Note, VaultModel } from "./vault.ts";

export type FindingCode =
  | "malformed"
  | "unknown-status"
  | "missing-block-id"
  | "duplicate-block-id"
  | "bad-source-link"
  | "missing-heading"
  | "heading-not-found"
  | "ambiguous-heading"
  | "source-integrity"
  | "quote-too-short"
  | "quote-not-in-section"
  | "quote-not-in-source"
  | "number-not-in-quote"
  | "number-word"
  | "identifier-mismatch";

export interface ClaimFinding {
  path: string;
  line: number;
  /** The block ID of the callout, or null when it has none. */
  claim: string | null;
  code: FindingCode;
  message: string;
}

/** A flagged fact: reported with its reason, not a failure. */
export interface FlaggedClaim {
  path: string;
  line: number;
  claim: string | null;
  reason: string;
}

export interface ClaimsReport {
  /** The vault-relative paths linted, once each, in the order given. */
  notes: string[];
  facts: number;
  conflicts: number;
  /** Fact counts by status: drafted, checked, verified, superseded, flagged. */
  by_status: Record<string, number>;
  /** Drafted, checked, and verified facts that passed every check. Flagged and superseded facts never count. */
  fully_checked: number;
  findings: ClaimFinding[];
  flagged: FlaggedClaim[];
  /** Things that do not fail the lint, such as a code fence that is never closed. */
  warnings: ClaimWarning[];
}

/** A note problem that does not fail the lint. */
export interface ClaimWarning {
  path: string;
  line: number;
  message: string;
}

const FACT_STATUSES = new Set(["drafted", "checked", "verified", "superseded"]);
const FLAGGED = /^flagged:\s*(\S.*)$/;
const CONFLICT_STATUS = /^(?:open|resolved:\s*\S.*)$/;
const START = /^ {0,3}>[ \t]?\[!(fact|conflict)\](.*)$/i;
const MISSED_START = /^[\s>*+\-\d.)]*\[!(?:fact|conflict)[^\]]*\]/i;
const QUOTE_LINE = /^ {0,3}>/;
const BLOCK_ID_LINE = /^\^\S+\s*$/;
const ID_FORMS = {
  fact: /^\^fact-[a-z0-9]+(?:-[a-z0-9]+)*\s*$/,
  conflict: /^\^conflict-[a-z0-9]+(?:-[a-z0-9]+)*\s*$/,
};
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const SOURCE_LINE = /^\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|[^\]]*)?\]\]$/;
const ELISION = /\[\s*(?:\.{3}|…)\s*\]|…|\.{3}/;
const ALNUM = /[\p{L}\p{N}]/u;
const DIGIT = /\d/;
const LETTER = /\p{L}/u;

// Text normalization -------------------------------------------------------

const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const CURLY_SINGLE = /[‘’‚‛]/g;
const CURLY_DOUBLE = /[“”„‟]/g;
const UNICODE_HYPHEN = /[‐‑]/g;
const SUPERSCRIPT = /[⁺⁻⁰¹²³⁴-⁹]+/g;
const SUPERSCRIPT_CHARS: Record<string, string> = {
  "⁺": "+",
  "⁻": "-",
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
};
const LATEX_SYMBOLS: Record<string, string> = {
  pm: "±",
  times: "×",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  approx: "≈",
};
/**
 * Tags a converter leaves in text; other `<...>` stays, so `n<m ... p>0.05`
 * and `<https://...>` keep their text. Inline tags vanish, and block, table,
 * and MathML tags leave a space, so `54.69</td><td>65.92` does not merge. A
 * MathML `<annotation>` repeats the formula as LaTeX and is dropped.
 */
const INLINE_TAG = /<\/?(?:a|b|i|u|s|em|strong|span|code|small|mark)\b[^<>]*>/gi;
const BLOCK_TAG =
  /<\/?(?:br|p|li|ul|ol|div|table|thead|tbody|tfoot|tr|td|th|img|figure|figcaption|h[1-6]|sup|sub|math|semantics|mrow|mi|mo|mn|mfrac|msup|msub|msqrt|mtext|mstyle|mspace)\b[^<>]*>/gi;
const ANNOTATION = /<annotation\b[^<>]*>[^<]*<\/annotation>/gi;
/** A `<sup>` whose content is text and links, with no other tag inside. */
const SUPERSCRIPT_TAG = /<sup>([^<]*(?:<a\b[^<>]*>[^<]*<\/a>[^<]*)*)<\/sup>/gi;

/**
 * `10<sup>4</sup>` is `10^4` and `(a+b)<sup>2</sup>` is `(a+b)^2`: a superscript that
 * directly follows a digit or `)` and holds no link is a power. Any other
 * superscript (`x<sup>2</sup>`, `images<sup><a>37</a></sup>`) is a footnote or
 * citation marker and is dropped, with its digits.
 */
function superscripts(text: string): string {
  return text.replace(SUPERSCRIPT_TAG, (_all, inner: string, at: number) => {
    const before = text[at - 1] ?? "";
    return /[\d)]/.test(before) && !/<a\b/i.test(inner) ? `^${inner}` : "";
  });
}
const SUBSCRIPT_TAG = /<sub>([^<>]*)<\/sub>/gi;

const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;

/** A Unicode decimal digit (Arabic-Indic, Devanagari, ...) as its ASCII digit. Digits come in runs of ten that start at zero. */
function asciiDigit(char: string): string {
  let at = char.codePointAt(0) as number;
  let before = 0;
  while (before < 60 && /\p{Nd}/u.test(String.fromCodePoint(at - 1))) {
    at--;
    before++;
  }
  return String(before % 10);
}

/** `10⁻⁴` as `10^-4`, so NFKC cannot turn it into `10-4` or `104`. */
function plainSuperscripts(text: string): string {
  return text.replace(SUPERSCRIPT, (run) => {
    let digits = "";
    for (const char of run) {
      digits += SUPERSCRIPT_CHARS[char] ?? String.fromCharCode(char.charCodeAt(0) - 0x2070 + 48);
    }
    return `^${digits}`;
  });
}

/**
 * Reduce text to the form in which a quote and a source section are
 * compared. The same function runs on both sides, in this order:
 * superscript digits made `^` and digits (`10⁴` is `10^4`); NFKC (ligatures,
 * no-break spaces, full-width forms); soft hyphens and zero-width characters
 * removed; curly quotes made straight; Unicode hyphens made `-`; `+/-` made
 * `±`; LaTeX `\pm \times \le \leq \ge \geq \approx` made symbols and `^{-3}`
 * made `^-3`; Markdown links reduced to their label; footnote references and
 * known HTML tags removed (`10<sup>4</sup>` is `10^4`; a `<sup>` after a letter or with a link is a marker and is dropped; `<sub>2</sub>` is `_2`; block and
 * table tags leave a space, `<annotation>` goes); any Unicode digit made ASCII; backslash escapes resolved; `*` and backticks
 * removed, and `$` removed unless a letter and a digit surround it (`US$5`);
 * a removed mark between a digit and a digit or letter, or a letter and a digit,
 * leaves a space, so `3*5` is not `35` and `n*5000` is not `n5000`;
 * `±`, `×`, `≤`, `≥`, and `≈` set off by single spaces; runs of white space
 * made one space; and `95 %` made `95%`. Every pattern is linear in the text.
 */
function normalizeText(text: string): string {
  return superscripts(markup(text))
    .replace(INLINE_TAG, "")
    .replace(SUBSCRIPT_TAG, "_$1")
    .replace(BLOCK_TAG, " ")
    .replace(/\\([\\`*_{}[\]()#+\-.!|$%<>~&"'])/g, "$1")
    .replace(/(?<=\d)[*`$]+(?=[\p{L}\d])|(?<=\p{L})[*`]+(?=\d)/gu, " ")
    .replace(/(?<!\p{L})\$|\$(?!\d)|[*`]/gu, "")
    .replace(/[±×≤≥≈]/g, " $& ")
    .replace(/\s+/g, " ")
    .replace(/(\d) %/g, "$1%")
    .trim();
}

/** The steps of `normalizeText` that come before superscript tags are read. */
function markup(text: string): string {
  return plainSuperscripts(text)
    .normalize("NFKC")
    .replace(NON_ASCII_DIGIT, asciiDigit)
    .replace(INVISIBLE, "")
    .replace(CURLY_SINGLE, "'")
    .replace(CURLY_DOUBLE, '"')
    .replace(UNICODE_HYPHEN, "-")
    .replace(/\+\/-/g, "±")
    .replace(/\\(leq|le|geq|ge|pm|times|approx)(?![A-Za-z])/g, (_all, name: string) => {
      return ` ${LATEX_SYMBOLS[name]} `;
    })
    .replace(/\^\{([+-]?\d+)\}/g, "^$1")
    .replace(/\[([^\][]*)\]\([^()]*\)/g, "$1")
    .replace(/\[\^[^\][]+\]/g, "")
    .replace(ANNOTATION, "");
}

/** Whether a token would run on across position `i`, between `text[i - 1]` and `text[i]`. */
function glued(text: string, i: number): boolean {
  const left = text[i - 1];
  const right = text[i];
  if (left === undefined || right === undefined) return false;
  if (ALNUM.test(left) && ALNUM.test(right)) return true;
  // The edge of a number: `3` against `3.5`, or `.5` against `0.5`.
  if (DIGIT.test(left) && /[.,]/.test(right) && DIGIT.test(text[i + 1] ?? "")) return true;
  return /[.,]/.test(left) && DIGIT.test(right) && DIGIT.test(text[i - 2] ?? "");
}

/** Whether every segment occurs in `text`, in order, without starting or ending inside a word or number. */
function containsInOrder(text: string, segments: readonly string[]): boolean {
  let cursor = 0;
  for (const segment of segments) {
    let at = text.indexOf(segment, cursor);
    while (at !== -1 && (glued(text, at) || glued(text, at + segment.length))) {
      at = text.indexOf(segment, at + 1);
    }
    if (at === -1) return false;
    cursor = at + segment.length;
  }
  return true;
}

// Source sections ----------------------------------------------------------

interface Heading {
  level: number;
  key: string;
  line: number;
}

/** A heading as a link names it: normalized, without the characters a link cannot hold, in lower case. */
function headingKey(text: string): string {
  return normalizeText(text)
    .replace(/[#|^:[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Which lines are inside a code fence, fence lines included. A backtick
 * fence whose info string holds a backtick is not a fence, and a closing
 * fence has no text after it (CommonMark). An unclosed fence runs to the end.
 */
function fencedLines(lines: readonly string[]): { inside: boolean[]; openAt: number | null } {
  const inside: boolean[] = [];
  let open: string | null = null;
  let openAt: number | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    const marker = match?.[1] as string;
    const info = match?.[2] as string;
    if (open !== null) {
      inside.push(true);
      if (match && marker[0] === open[0] && marker.length >= open.length && info.trim() === "") {
        open = null;
        openAt = null;
      }
    } else if (match && !(marker[0] === "`" && info.includes("`"))) {
      open = marker;
      openAt = inside.length;
      inside.push(true);
    } else inside.push(false);
  }
  return { inside, openAt };
}

/** The text of an ATX heading line without its closing `#` marks, or null. */
function headingText(line: string): { level: number; text: string } | null {
  const match = HEADING.exec(line);
  if (!match) return null;
  const text = (match[2] as string).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  const closed = end < text.length && (end === 0 || /\s/.test(text[end - 1] as string));
  return { level: (match[1] as string).length, text: closed ? text.slice(0, end).trimEnd() : text };
}

/** The ATX headings of `lines`, outside code fences. */
function headingsOf(lines: readonly string[]): Heading[] {
  const fenced = fencedLines(lines).inside;
  const found: Heading[] = [];
  lines.forEach((line, i) => {
    const heading = fenced[i] ? null : headingText(line);
    if (heading) found.push({ level: heading.level, key: headingKey(heading.text), line: i });
  });
  return found;
}

interface SourceText {
  lines: string[];
  headings: Heading[];
  /** The whole body, normalized. */
  all: string;
  /** What is wrong with the source's manifest, or null. */
  integrity: string | null;
}

type Section = { ok: true; text: string } | { ok: false; code: FindingCode; message: string };

/**
 * The normalized text under a heading: from the line after it to the next
 * heading of the same or a higher level, so subsections belong to it, as in
 * an Obsidian embed of a heading.
 */
function sectionText(source: SourceText, heading: string): Section {
  const key = headingKey(heading);
  const matches = source.headings.filter((h) => h.key === key);
  if (matches.length === 0) {
    return {
      ok: false,
      code: "heading-not-found",
      message: `the source has no heading "${heading}"`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: "ambiguous-heading",
      message: `the source has ${matches.length} headings named "${heading}"; a link reaches only the first`,
    };
  }
  const at = matches[0] as Heading;
  const next = source.headings.find((h) => h.line > at.line && h.level <= at.level);
  const lines = source.lines.slice(at.line + 1, next ? next.line : source.lines.length);
  return { ok: true, text: normalizeText(lines.join("\n")) };
}

/**
 * The raw text of a note body under `heading`, as `sectionText` bounds it.
 * A heading that is missing or named twice is an error that lists the
 * body's headings, so the caller can pick one without reading the body.
 */
export function bodySection(body: string, heading: string): string {
  const lines = body.split("\n");
  const headings = headingsOf(lines);
  const key = headingKey(heading);
  const matches = headings.filter((h) => h.key === key);
  if (matches.length !== 1) {
    const listed = headings.map((h) => lines[h.line]?.trim()).join(" | ");
    const problem = matches.length === 0 ? "no heading" : `${matches.length} headings`;
    throw new Error(`the note has ${problem} named "${heading}"; its headings: ${listed}`);
  }
  const at = matches[0] as Heading;
  const next = headings.find((h) => h.line > at.line && h.level <= at.level);
  return lines.slice(at.line + 1, next ? next.line : lines.length).join("\n");
}

/** What is wrong with a source note's manifest: its text hash or its source ID. */
function manifestProblem(note: Note): string | null {
  const { sha256_text: hash, source_id: id } = note.properties;
  if (typeof id !== "string" || id.trim() === "") return "its manifest has no source_id";
  if (typeof hash !== "string" || hash === "") return "its manifest has no sha256_text";
  const actual = createHash("sha256").update(note.body).digest("hex");
  return actual === hash
    ? null
    : `its sha256_text (${hash.slice(0, 12)}...) does not match the text (${actual.slice(0, 12)}...)`;
}

// Numbers ------------------------------------------------------------------

interface NumberToken {
  /** The digits and decimal point without thousands separators, plus any exponent (`59e-9`, `10^4`). */
  value: string;
  /** A `%` or the word `percent` follows the number. */
  percent: boolean;
  /** A `±` precedes the number. */
  plusMinus: boolean;
  /** A minus sign (`-`, `−`, or `–`) directly precedes the number, with no letter or digit before it. */
  negative: boolean;
  /** Where the number starts in the text. */
  index: number;
}

const NUMBER = /(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[eE][+-]?\d+|\^[+-]?\d+)?/g;
const MINUS = new Set(["-", "−", "–"]);

/** Whether the digits at `start` carry a minus sign: `-3`, but not `top-1`, `5-fold`, or the `20` of `10-20`. */
function isNegative(text: string, start: number): boolean {
  if (!MINUS.has(text[start - 1] ?? "")) return false;
  const left = text[start - 2];
  return left === undefined || !ALNUM.test(left);
}

const PERCENT_WORD = /\s?percent\b/iy;

/** Whether the first non-space character before `at` is a `±`. */
function afterPlusMinus(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i] as string)) i--;
  return text[i] === "±";
}

/** Every number in normalized text, with the sign, `%`, and `±` attached to it. */
function numbersIn(text: string): NumberToken[] {
  return [...text.matchAll(NUMBER)].map((match) => {
    const end = match.index + match[0].length;
    PERCENT_WORD.lastIndex = end;
    return {
      value: match[0].replace(/(?<=\d),(?=\d{3})/g, ""),
      percent: text[end] === "%" || PERCENT_WORD.test(text),
      plusMinus: afterPlusMinus(text, match.index),
      negative: isNegative(text, match.index),
      index: match.index,
    };
  });
}

/**
 * The identifier the digits at `start` belong to, if any (`v2`, `DINOv2`,
 * `L2`, `top-1`, `ResNet-50`, `COVID-19`, `1.2.3`): a letter or `_` directly
 * before, a letter and one `-` before, or a dotted number before. For the
 * form `letters-digits` it also gives the letters.
 */
function identifierAt(text: string, start: number): { prefix: string | null } | null {
  const before = text[start - 1];
  const earlier = text[start - 2];
  if (before === undefined) return null;
  const lettersBefore = (end: number): string => {
    let from = end;
    while (from > 0 && LETTER.test(text[from - 1] as string)) from--;
    return text.slice(from, end).toLowerCase();
  };
  if (LETTER.test(before)) {
    // `224x300` is two numbers; `USD9999` is an amount.
    if ((before === "x" || before === "X") && earlier !== undefined && DIGIT.test(earlier))
      return null;
    const letters = lettersBefore(start);
    return CURRENCY_CODES.has(letters) ? null : { prefix: letters };
  }
  if (before === "_") return { prefix: null };
  if (before === "-" && earlier !== undefined && LETTER.test(earlier)) {
    return { prefix: lettersBefore(start - 1) };
  }
  return before === "." && earlier !== undefined && DIGIT.test(earlier) ? { prefix: null } : null;
}

const CURRENCY_CODES = new Set(["usd", "eur", "gbp", "jpy", "cny"]);
const NAME = String.raw`\p{Lu}[\p{L}'’-]*`;
const YEAR = String.raw`(?:19|20)\d{2}[a-z]?`;
const CITATION = String.raw`${NAME}(?: et al\.| (?:and|&) ${NAME})?,\s*${YEAR}`;
const CITATION_PARENS = new RegExp(String.raw`\(${CITATION}(?:;\s*${CITATION})*\)`, "gu");
const CITATION_AL = new RegExp(String.raw`(?<!\p{L})${NAME} et al\. \(${YEAR}\)`, "gu");

/**
 * The start of each year in a citation of one of these shapes only:
 * `(Name, 2018)`, `(Name et al., 2018)`, `(Name and Name, 2018)` (several,
 * separated by `;`), and `Name et al. (2018)`, each year with an optional
 * letter (`2018a`). `(Rhesus, 2000 images)`, `(N = 1999)`, and `Dataset (2000)`
 * are not citations, so their numbers are checked.
 */
function citationYears(text: string): Set<number> {
  const exempt = new Set<number>();
  for (const pattern of [CITATION_PARENS, CITATION_AL]) {
    for (const match of text.matchAll(pattern)) {
      for (const year of match[0].matchAll(/(?:19|20)\d{2}(?=[a-z]?(?:[);,]|$))/g)) {
        exempt.add(match.index + year.index);
      }
    }
  }
  return exempt;
}

const NUMBER_WORDS =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half|twice|double|triple|percent|thousands|hundreds|dozens|doubled|tripled|halved|quadrupled|couple)\b/giu;

/**
 * The number words of a fact that its quote does not use too; `percent` right
 * after a digit is the `%` sign, not a word. A word the quote has (`five`) is
 * the source's own and can be checked.
 */
function numberWords(text: string, quoteText: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(NUMBER_WORDS)) {
    const word = match[0].toLowerCase();
    if (word === "percent" && /\d\s?$/.test(text.slice(0, match.index))) continue;
    if (new RegExp(String.raw`\b${word}\b`, "iu").test(quoteText)) continue;
    if (!found.includes(word)) found.push(word);
  }
  return found;
}

/** The digits that follow each `letters-` prefix in text, by lower-case prefix. */
function quoteIdentifiers(text: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const match of text.matchAll(/(\p{L}+)-?(\d+(?:\.\d+)?)/gu)) {
    const prefix = (match[1] as string).toLowerCase();
    found.set(prefix, (found.get(prefix) ?? new Set()).add(match[2] as string));
  }
  return found;
}

interface NumberCheck {
  /** Numbers of the fact that the quote lacks. */
  missing: string[];
  /** Identifiers such as `ResNet-101` where the quote names another number after the same prefix. */
  mismatched: string[];
}

/**
 * Check the numbers of a fact (or statement) against its quote text. Left
 * out: citation years of the shapes above, and digits inside identifiers
 * unless the quote has the same `letters-` prefix with other digits.
 */
function checkNumbers(factText: string, quoteText: string): NumberCheck {
  const exempt = citationYears(factText);
  const quoteNames = quoteIdentifiers(quoteText);
  const available = numbersIn(quoteText);
  const result: NumberCheck = { missing: [], mismatched: [] };
  for (const token of numbersIn(factText)) {
    if (exempt.has(token.index)) continue;
    const identifier = identifierAt(factText, token.index);
    if (identifier) {
      const seen = identifier.prefix === null ? undefined : quoteNames.get(identifier.prefix);
      if (seen && !seen.has(token.value)) {
        const shown = `${identifier.prefix}-${token.value}`;
        if (!result.mismatched.includes(shown)) result.mismatched.push(shown);
      }
      continue;
    }
    const found = available.some(
      (have) =>
        have.value === token.value &&
        have.negative === token.negative &&
        (!token.percent || have.percent) &&
        (!token.plusMinus || have.plusMinus),
    );
    const shown = `${token.plusMinus ? "±" : ""}${token.negative ? "-" : ""}${token.value}${token.percent ? "%" : ""}`;
    if (!found && !result.missing.includes(shown)) result.missing.push(shown);
  }
  return result;
}

// Callouts -----------------------------------------------------------------

interface Callout {
  kind: "fact" | "conflict";
  /** The title, which is the status. */
  title: string;
  /** Index of the callout's first line. */
  at: number;
  /** The callout's lines without their `>` marker. */
  inner: string[];
  /** The block ID line after the callout and one blank line, or null. */
  id: string | null;
  /** The block ID sits on the callout's next line, with no blank line between. */
  joined: boolean;
}

/** The fact and conflict callouts of a body, outside code fences. */
function calloutsOf(lines: readonly string[], fenced: readonly boolean[]): Callout[] {
  const found: Callout[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = fenced[i] ? null : START.exec(lines[i] as string);
    if (!start) continue;
    const inner: string[] = [];
    let end = i + 1;
    while (end < lines.length && QUOTE_LINE.test(lines[end] as string)) {
      inner.push((lines[end] as string).replace(/^ {0,3}>[ \t]?/, ""));
      end++;
    }
    // The ID goes on its own line after one blank line, as Obsidian documents
    // for structured blocks. Directly under the callout it would be read as
    // part of the callout's last line.
    const joined = BLOCK_ID_LINE.test(lines[end] ?? "");
    const idLine = joined
      ? lines[end]
      : (lines[end] ?? "").trim() === "" && BLOCK_ID_LINE.test(lines[end + 1] ?? "")
        ? lines[end + 1]
        : undefined;
    found.push({
      kind: (start[1] as string).toLowerCase() as "fact" | "conflict",
      title: (start[2] as string).trim(),
      at: i,
      inner,
      id: idLine === undefined ? null : (idLine as string).trim(),
      joined,
    });
    i = end - 1;
  }
  return found;
}

type TokenType = "T" | "Q" | "S";

/** The callout's content as runs of fact text (T), quote (Q), and source line (S). */
function tokensOf(inner: readonly string[]): { type: TokenType; text: string }[] {
  const tokens: { type: TokenType; text: string }[] = [];
  let open = false;
  for (const line of inner) {
    if (line.trim() === "") {
      open = false;
      continue;
    }
    const type: TokenType = line.startsWith(">") ? "Q" : line.startsWith("— ") ? "S" : "T";
    const text = type === "Q" ? line.replace(/^>[ \t]?/, "") : type === "S" ? line.slice(2) : line;
    const last = tokens.at(-1);
    if (open && last && last.type === type && type !== "S") last.text += ` ${text.trim()}`;
    else tokens.push({ type, text: text.trim() });
    open = true;
  }
  return tokens;
}

const WRAPPED = /^["“”]([\s\S]*)["“”]$/;

/** The quote's parts, normalized, split at elisions; null when the quote is not in quotation marks. */
function quoteParts(raw: string): string[] | null {
  const wrapped = WRAPPED.exec(raw);
  if (!wrapped) return null;
  return (wrapped[1] as string)
    .split(ELISION)
    .map(normalizeText)
    .filter((part) => part !== "");
}

const STOP_WORDS = new Set(
  "a an the of in on at to and or is are was were be been by for with as that this these those it its from we our has have had not no but if than then so which who whom whose can may will".split(
    " ",
  ),
);

/** Words of a normalized part: its space-separated tokens that hold a letter or a digit. */
function wordsIn(part: string): string[] {
  return part.split(" ").filter((token) => ALNUM.test(token));
}

/** Why a quote cannot stand as evidence, or null: under 6 words, or a part under 3 words or without a word of its own. */
function tooShort(parts: readonly string[]): string | null {
  const total = parts.reduce((sum, part) => sum + wordsIn(part).length, 0);
  if (total < 6) return `the quote has ${total} word(s); a quote needs at least 6`;
  for (const part of parts) {
    const words = wordsIn(part);
    if (words.length < 3) return `the quote part "${part}" has fewer than 3 words`;
    const own = words.some((word) => {
      const letters = word.toLowerCase().replace(/[^\p{L}]/gu, "");
      return letters !== "" && !STOP_WORDS.has(letters);
    });
    if (!own) return `the quote part "${part}" holds only stop words, numbers, or punctuation`;
  }
  return null;
}

/**
 * The fact or statement text as the number check reads it: the numbers the
 * reader sees. A wikilink with a label counts as its label; one without counts
 * as its target and heading as written (`note#5000 more images` has 5000). An
 * autolink `<https://...>` counts as its URL text, and a Markdown link as its label.
 */
function statementText(text: string): string {
  return normalizeText(
    text.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_all, target: string, label?: string) => {
      return ` ${label ?? target.replaceAll("#", " ")} `;
    }),
  );
}

// The lint -----------------------------------------------------------------

/** Lint the fact and conflict callouts of `notes`, each note once. */
export function lintClaims(model: VaultModel, notes: readonly Note[]): ClaimsReport {
  const unique = [...new Map(notes.map((note) => [note.path, note])).values()];
  const report: ClaimsReport = {
    notes: unique.map((note) => note.path),
    facts: 0,
    conflicts: 0,
    by_status: { drafted: 0, checked: 0, verified: 0, superseded: 0, flagged: 0 },
    fully_checked: 0,
    findings: [],
    flagged: [],
    warnings: [],
  };
  const sources = new Map<string, SourceText>();
  const sourceText = (note: Note): SourceText => {
    let text = sources.get(note.path);
    if (text === undefined) {
      const lines = note.body.split("\n");
      text = {
        lines,
        headings: headingsOf(lines),
        all: normalizeText(note.body),
        integrity: manifestProblem(note),
      };
      sources.set(note.path, text);
    }
    return text;
  };

  for (const note of unique) {
    const lineOffset =
      note.text.slice(0, note.text.length - note.body.length).split("\n").length - 1;
    const lines = note.body.split("\n");
    const { inside: fenced, openAt } = fencedLines(lines);
    if (openAt !== null) {
      report.warnings.push({
        path: note.path,
        line: lineOffset + openAt + 1,
        message: `fence opened at line ${lineOffset + openAt + 1} is never closed; ${lines.length - openAt} lines not linted`,
      });
    }
    const seen = new Map<string, number>();
    const callouts = calloutsOf(lines, fenced);

    // A line that starts like `[!fact…]` or `[!conflict…]` but did not start a callout is never skipped silently.
    const starts = new Set(callouts.map((callout) => callout.at));
    lines.forEach((text, i) => {
      if (fenced[i] || starts.has(i) || !MISSED_START.test(text)) return;
      report.findings.push({
        path: note.path,
        line: lineOffset + i + 1,
        claim: null,
        code: "malformed",
        message:
          "this line looks like a [!fact] or [!conflict] callout but does not start one; write `> [!fact] <status>` at the start of a line, not indented, in a list, nested, or with another type name",
      });
    });

    for (const callout of callouts) {
      const line = lineOffset + callout.at + 1;
      const claim = callout.id === null ? null : callout.id.slice(1);
      const finding = (code: FindingCode, message: string): void => {
        report.findings.push({ path: note.path, line, claim, code, message });
      };
      const findingsBefore = report.findings.length;

      const fact = callout.kind === "fact";
      let flaggedReason: string | null = null;
      let status = callout.title;
      if (fact) {
        flaggedReason = FLAGGED.exec(callout.title)?.[1] ?? null;
        if (flaggedReason !== null) status = "flagged";
        report.facts++;
      } else report.conflicts++;

      const known = fact
        ? FACT_STATUSES.has(status) || flaggedReason !== null
        : CONFLICT_STATUS.test(status);
      if (!known) {
        const allowed = fact
          ? "drafted, checked, verified, superseded, or 'flagged: <reason>'"
          : "open or 'resolved: <reason>'";
        finding("unknown-status", `the title "${callout.title}" is not a status; use ${allowed}`);
        continue;
      }
      if (fact) report.by_status[status] = (report.by_status[status] ?? 0) + 1;

      // A block ID must be unique in its note, whatever the status.
      const form = ID_FORMS[callout.kind];
      const idOk = callout.id !== null && form.test(callout.id);
      if (callout.id !== null && idOk) {
        const first = seen.get(callout.id);
        if (first === undefined) seen.set(callout.id, line);
        else finding("duplicate-block-id", `${callout.id} is already used at line ${first}`);
      }
      if (status === "superseded") continue;
      if (callout.joined) {
        finding(
          "malformed",
          `the block ID ${callout.id} must follow a blank line; directly under the callout it belongs to the callout's last line`,
        );
      } else if (callout.id !== null && !idOk) {
        finding(
          "malformed",
          `the block ID ${callout.id} must read ^${callout.kind}-<slug> (lowercase letters, digits, hyphens)`,
        );
      } else if (callout.id === null && flaggedReason === null) {
        finding(
          "missing-block-id",
          `no ^${callout.kind}-<slug> block ID on its own line after a blank line below the callout`,
        );
      }

      const tokens = tokensOf(callout.inner);
      const shape = tokens.map((token) => token.type).join("");
      const allowedShape = fact ? (flaggedReason === null ? /^T+QS$/ : /^T+Q?S$/) : /^T+QSQS$/;
      if (!allowedShape.test(shape)) {
        const found = tokens
          .map((t) => ({ T: "text", Q: "quote", S: "source line" })[t.type])
          .join(", ");
        const expected = fact
          ? "the fact text, one quote, then a final '— ' source line"
          : "the statement, then two pairs of a quote and a '— ' source line";
        finding(
          "malformed",
          `a [!${callout.kind}] callout holds ${expected}; found: ${found || "nothing"}`,
        );
        continue;
      }
      if (flaggedReason !== null) {
        report.flagged.push({ path: note.path, line, claim, reason: flaggedReason });
        continue;
      }

      const rawText = tokens
        .filter((t) => t.type === "T")
        .map((t) => t.text)
        .join(" ");
      if (rawText.includes("![[")) {
        finding("malformed", "an embed (![[...]]) in the fact text is not allowed; use a link");
      }
      const text = statementText(rawText);

      const allParts: string[][] = [];
      const sourcesCited: (string | null)[] = [];
      const pairs = tokens.filter((t) => t.type !== "T");
      for (let p = 0; p < pairs.length; p += 2) {
        const parts = quoteParts((pairs[p] as { text: string }).text);
        if (parts === null || parts.length === 0) {
          finding("malformed", "the quote must be text in double quotation marks");
          continue;
        }
        const short = tooShort(parts);
        if (short !== null) finding("quote-too-short", short);
        allParts.push(parts);
        sourcesCited.push(
          checkQuote(
            model,
            note,
            (pairs[p + 1] as { text: string }).text,
            parts,
            sourceText,
            finding,
          ),
        );
      }

      if (!fact && allParts.length === 2) {
        if (allParts[0]?.join(" … ") === allParts[1]?.join(" … ")) {
          finding("malformed", "the two quotes of a conflict must differ");
        }
        if (sourcesCited[0] && sourcesCited[0] === sourcesCited[1]) {
          finding(
            "malformed",
            "the two quotes of a conflict must come from two different sources, not one source twice",
          );
        }
      }

      // Every number of the statement must occur in the quote, or, for a
      // conflict, in one of its two quotes.
      const quoteText = allParts.map((parts) => parts.join(" … ")).join(" … ");
      const words = numberWords(text, quoteText);
      if (words.length > 0) {
        finding(
          "number-word",
          `write numbers as digits, not words (${words.join(", ")}); a number word cannot be checked unless the quote uses the same word`,
        );
      }
      if (allParts.length > 0) {
        const numbers = checkNumbers(text, quoteText);
        if (numbers.missing.length > 0) {
          finding(
            "number-not-in-quote",
            `${numbers.missing.map((m) => `"${m}"`).join(", ")} in the ${fact ? "fact" : "statement"} ${numbers.missing.length === 1 ? "does" : "do"} not occur in the ${fact ? "quote" : "quotes"}`,
          );
        }
        if (numbers.mismatched.length > 0) {
          finding(
            "identifier-mismatch",
            `${numbers.mismatched.map((m) => `"${m}"`).join(", ")} in the ${fact ? "fact" : "statement"}: the ${fact ? "quote" : "quotes"} name${fact ? "s" : ""} the same prefix with other digits`,
          );
        }
      }
      if (fact && report.findings.length === findingsBefore) report.fully_checked++;
    }
  }
  return report;
}

/**
 * Check one quote against the source section its source line links to.
 * Returns the path of the source it cites, or null when the line names none.
 * The label after `|` is not read.
 */
function checkQuote(
  model: VaultModel,
  note: Note,
  sourceLine: string,
  parts: readonly string[],
  sourceText: (source: Note) => SourceText,
  finding: (code: FindingCode, message: string) => void,
): string | null {
  const link = SOURCE_LINE.exec(sourceLine.trim());
  if (!link) {
    finding(
      "bad-source-link",
      "the source line must be exactly '— [[path#heading]]' or '— [[path#heading|label]]', with nothing after the link",
    );
    return null;
  }
  const [, target = "", heading] = link;
  const source = model.resolveLink(target.trim(), note);
  if (source === undefined || !CAPTURE_NOTE.test(source.path)) {
    finding("bad-source-link", `"${target.trim()}" is not a captured source (raw/<slug>/source)`);
    return null;
  }
  const text = sourceText(source);
  if (text.integrity !== null) {
    finding(
      "source-integrity",
      `${source.path}: ${text.integrity}; the source cannot vouch for a quote`,
    );
  }
  if (heading === undefined || heading.trim() === "") {
    finding("missing-heading", `the link to ${source.path} names no heading`);
    return source.path;
  }
  const section = sectionText(text, heading);
  if (!section.ok) {
    finding(section.code, section.message);
  } else if (!containsInOrder(section.text, parts)) {
    const elsewhere = containsInOrder(text.all, parts);
    finding(
      elsewhere ? "quote-not-in-section" : "quote-not-in-source",
      elsewhere
        ? `the quote is not under "${heading.trim()}"; it occurs elsewhere in ${source.path}`
        : `the quote does not occur in ${source.path}`,
    );
  }
  return source.path;
}

/** The report as a readable summary: one line per finding or flagged fact, then the totals. */
export function summary(report: ClaimsReport): string {
  const lines = [
    ...report.findings.map(
      (f) => `${f.path}:${f.line} ${f.code}${f.claim ? ` (${f.claim})` : ""}: ${f.message}`,
    ),
    ...report.flagged.map(
      (f) => `${f.path}:${f.line} flagged${f.claim ? ` (${f.claim})` : ""}: ${f.reason}`,
    ),
    ...report.warnings.map((w) => `${w.path}:${w.line} warning: ${w.message}`),
  ];
  const statuses = Object.entries(report.by_status)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${n} ${name}`)
    .join(", ");
  lines.push(
    `${report.notes.length} note(s): ${report.facts} fact(s)${statuses ? ` (${statuses})` : ""}, ` +
      `${report.fully_checked} fully checked, ${report.conflicts} conflict(s); ` +
      `${report.findings.length} finding(s), ${report.flagged.length} flagged`,
  );
  return lines.join("\n");
}
