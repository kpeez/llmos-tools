/**
 * Markdown defects that make Obsidian render a note wrongly: a table row with
 * the wrong number of cells, an empty link, a reversed link, an unescaped
 * alias pipe in a table wikilink, and a hard-wrapped paragraph. This is not a
 * style linter. The first three rules come from markdownlint; the other two
 * are custom markdownlint rules, because only Obsidian splits a cell at
 * `[[a|b]]` and shows every single newline as a line break.
 */

import type { MicromarkToken, Rule } from "markdownlint";
import { lint } from "markdownlint/sync";
import { blankCodeSpans } from "./code-spans.ts";
import { MARKER_END, MARKER_START } from "./daily.ts";

export interface MarkdownFinding {
  code: string;
  line: number;
  message: string;
}

const PIPE_CODE = "table-wikilink-pipe";
const WRAP_CODE = "hard-wrapped-paragraph";

const CODES: Record<string, string> = {
  MD056: "table-column-count",
  MD042: "empty-link",
  MD011: "reversed-link",
  [PIPE_CODE]: PIPE_CODE,
  [WRAP_CODE]: WRAP_CODE,
};

const HARD_BREAKS = new Set(["hardBreakTrailing", "hardBreakEscape"]);

/** Whether inline tokens hold a line ending that is not a hard break, inside emphasis or links too. */
function hasSoftBreak(tokens: readonly MicromarkToken[]): boolean {
  return tokens.some(
    (token, i) =>
      (token.type === "lineEnding" && !HARD_BREAKS.has(tokens[i - 1]?.type ?? "")) ||
      hasSoftBreak(token.children),
  );
}

/** Start lines of paragraphs with a soft line ending, outside block quotes. */
function wrappedParagraphLines(tokens: readonly MicromarkToken[], lines: number[] = []): number[] {
  for (const token of tokens) {
    // A quoted source keeps its own line breaks (see the schema's quote rule).
    if (token.type === "blockQuote") continue;
    if (token.type === "paragraph") {
      if (hasSoftBreak(token.children)) lines.push(token.startLine);
      continue;
    }
    wrappedParagraphLines(token.children, lines);
  }
  return lines;
}

/** Lines inside a daily note's `llmos-activity` block, which only the digest writes. */
function activityBlockLines(tokens: readonly MicromarkToken[]): Set<number> {
  const owned = new Set<number>();
  let start: number | undefined;
  for (const token of tokens) {
    // markdownlint blanks HTML comments in `params.lines`, so read the markers from tokens.
    if (token.type !== "htmlFlow") continue;
    if (token.text.startsWith(MARKER_START)) start = token.startLine;
    if (token.text.startsWith(MARKER_END) && start !== undefined) {
      for (let line = start; line <= token.endLine; line++) owned.add(line);
      start = undefined;
    }
  }
  return owned;
}

const hardWrappedParagraph: Rule = {
  names: [WRAP_CODE],
  description: "A paragraph or list item must be one line, because Obsidian shows each newline",
  tags: ["obsidian"],
  parser: "micromark",
  function(params, onError) {
    const machineOwned = activityBlockLines(params.parsers.micromark.tokens);
    for (const lineNumber of wrappedParagraphLines(params.parsers.micromark.tokens)) {
      if (!machineOwned.has(lineNumber)) onError({ lineNumber });
    }
  },
};

// A wikilink or embed whose target or label part holds a pipe not preceded by a backslash.
const PIPE_WIKILINK = /!?\[\[[^\]\n]*?(?<!\\)\|[^\]\n]*\]\]/;

function tableRowLines(
  tokens: readonly MicromarkToken[],
  lines: Set<number> = new Set(),
): Set<number> {
  for (const token of tokens) {
    if ((token.type as string) === "tableRow") lines.add(token.startLine);
    tableRowLines(token.children, lines);
  }
  return lines;
}

const tableWikilinkPipe: Rule = {
  names: [PIPE_CODE],
  description: "An alias pipe in a wikilink inside a table row must be escaped",
  tags: ["table", "obsidian"],
  parser: "micromark",
  function(params, onError) {
    for (const lineNumber of tableRowLines(params.parsers.micromark.tokens)) {
      // An inline code span is hidden, so a literal `[[a|b]]` is not reported.
      const line = blankCodeSpans(params.lines[lineNumber - 1] ?? "");
      const match = PIPE_WIKILINK.exec(line);
      if (match) {
        onError({
          lineNumber,
          detail:
            `${match[0]} splits the table cell at its alias pipe; ` +
            "escape the pipe as `\\|` (for example `[[target\\|label]]`).",
        });
      }
    }
  },
};

/** Markdown correctness findings for a note's full text (frontmatter included), by file line. */
export function markdownFindings(text: string): MarkdownFinding[] {
  const results = lint({
    strings: { note: text },
    config: {
      default: false,
      MD056: true,
      MD042: true,
      MD011: true,
      [PIPE_CODE]: true,
      [WRAP_CODE]: true,
    },
    customRules: [tableWikilinkPipe, hardWrappedParagraph],
  }).note;
  const pipeLines = new Set<number>();
  for (const r of results ?? []) if (r.ruleNames[0] === PIPE_CODE) pipeLines.add(r.lineNumber);
  const findings: MarkdownFinding[] = [];
  for (const r of results ?? []) {
    const code = CODES[r.ruleNames[0] as string];
    // The pipe finding names the cause, so it replaces the cell-count finding on its line.
    if (code === undefined || (code === "table-column-count" && pipeLines.has(r.lineNumber))) {
      continue;
    }
    findings.push({ code, line: r.lineNumber, message: describe(code, r) });
  }
  return findings.sort((a, b) => a.line - b.line || (a.code < b.code ? -1 : 1));
}

function describe(
  code: string,
  r: { ruleDescription: string; errorDetail: string | null; errorContext: string | null },
): string {
  const detail = r.errorDetail ? ` (${r.errorDetail})` : "";
  switch (code) {
    case "table-column-count":
      return `This table row has the wrong number of cells${detail}; Obsidian drops or pads cells. Make every row match the header, and escape a literal pipe as \`\\|\`.`;
    case "empty-link":
      return `Empty link destination${r.errorContext ? ` in ${r.errorContext}` : ""}; give the link a target or remove the link syntax.`;
    case "reversed-link":
      return `Reversed link syntax${r.errorContext ? ` ${r.errorContext}` : ""}${detail}; write [text](target), not (text)[target].`;
    case WRAP_CODE:
      return "This paragraph or list item is hard-wrapped; Obsidian shows each newline as a line break. Put the whole paragraph or item on one line.";
    default:
      return r.errorDetail ?? r.ruleDescription;
  }
}
