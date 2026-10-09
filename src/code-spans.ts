/**
 * Inline code spans as CommonMark reads them. Every reader of link-like text
 * (`vault.ts`, `authoring.ts`, `markdown-lint.ts`) uses this one rule, so a
 * span that hides a link is the same in every command.
 */

/** ASCII punctuation, the characters a backslash escapes (the backtick among them). */
const ESCAPABLE = /[!-/:-@[-`{-~]/;
/** A blank line: the end of a paragraph, where a code span cannot continue. */
const BLANK_LINE_AT = /\n[ \t]*\n/y;

/** One inline code span: its offsets and the text between its backtick runs. */
export interface CodeSpan {
  /** Offset of the opening backtick run. */
  readonly start: number;
  /** Offset just past the closing backtick run. */
  readonly end: number;
  /** The text between the two runs, as written. */
  readonly content: string;
}

/** Offset just past the backtick run that starts at `from`. */
function runEnd(text: string, from: number): number {
  let end = from;
  while (text[end] === "`") end++;
  return end;
}

/**
 * Offset just past the closing run of exactly `length` backticks, searched
 * from `from`, or -1 when a blank line or the end of the text comes first.
 */
function closeEnd(text: string, from: number, length: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "\n") {
      BLANK_LINE_AT.lastIndex = i;
      if (BLANK_LINE_AT.test(text)) return -1;
      i++;
    } else if (text[i] === "`") {
      const end = runEnd(text, i);
      if (end - i === length) return end;
      i = end;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * The inline code spans of `text`, left to right. A span opens at a backtick
 * run that no backslash escapes, and closes only at a run of exactly the same
 * length. It never crosses a blank line. An opening run with no closer is
 * literal text, and scanning goes on after it.
 */
export function codeSpans(text: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      i += 2;
    } else if (text[i] === "`") {
      const open = runEnd(text, i);
      const length = open - i;
      const end = closeEnd(text, open, length);
      if (end === -1) {
        i = open;
      } else {
        spans.push({ start: i, end, content: text.slice(open, end - length) });
        i = end;
      }
    } else {
      i++;
    }
  }
  return spans;
}

/** `text` with every inline code span blanked to spaces. Line breaks and offsets are kept. */
export function blankCodeSpans(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  for (const span of codeSpans(text)) {
    parts.push(
      text.slice(copied, span.start),
      text.slice(span.start, span.end).replace(/[^\n]/g, " "),
    );
    copied = span.end;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}
