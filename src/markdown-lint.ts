/**
 * Markdown defects that make Obsidian render a note wrongly: a table row with
 * the wrong number of cells, an empty link, a reversed link, and an
 * unescaped alias pipe in a table wikilink. This is not a style linter.
 * The first three rules come from markdownlint; the pipe rule is a custom
 * markdownlint rule, because only Obsidian splits a cell at `[[a|b]]`.
 */

import type { MicromarkToken, Rule } from "markdownlint";
import { lint } from "markdownlint/sync";
import { blankCodeSpans } from "./code-spans.ts";

export interface MarkdownFinding {
  code: string;
  line: number;
  message: string;
}

const PIPE_CODE = "table-wikilink-pipe";

const CODES: Record<string, string> = {
  MD056: "table-column-count",
  MD042: "empty-link",
  MD011: "reversed-link",
  [PIPE_CODE]: PIPE_CODE,
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
    config: { default: false, MD056: true, MD042: true, MD011: true, [PIPE_CODE]: true },
    customRules: [tableWikilinkPipe],
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
    default:
      return r.errorDetail ?? r.ruleDescription;
  }
}
