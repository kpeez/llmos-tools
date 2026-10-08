/**
 * Intended differences between the Python and TypeScript results.
 *
 * Each entry names one class of difference and why it is intended. Every
 * difference the harness finds must match an entry here, or the run fails.
 * Keep this list short; an entry is a decision, not a way to silence drift.
 *
 * The harness compares in two steps (see `run.ts`):
 *
 * - `python-vs-compatible`: Python against a TypeScript run that reads the
 *   notes Python refuses the way Python reads them (no properties). Only
 *   `normalize` results and the listed internal differences (message
 *   wording, date forms, the qmd field) may differ here.
 * - `compatible-vs-full`: that run against the real TypeScript run. The two
 *   differ only in the properties of the notes Python refuses, so every
 *   difference here follows from reading those properties.
 */

import { isDeepStrictEqual } from "node:util";

export type Comparison = "python-vs-compatible" | "compatible-vs-full" | "invariant";

export interface Difference {
  vault: string;
  comparison: Comparison;
  /** The compared result: `list`, `read`, `neighbors`, `subgraph1`, `subgraph2`, `check`, `normalize`, `by_name`, `health.<field>`, `schema.<field>`, or `note-set`. */
  section: string;
  /** The note path or name the result belongs to ("" for vault-wide results). */
  key: string;
  python: unknown;
  typescript: unknown;
  /** For `normalize`: the YAML features of the note's frontmatter block. */
  features?: string[];
  /** For `normalize`: the note's text on disk. */
  text?: string;
  /** For `health.stale_inbox`: each inbox note's `created` property, as the TypeScript run read it. */
  created?: Record<string, unknown>;
}

export interface AllowlistEntry {
  id: string;
  reason: string;
  matches(difference: Difference): boolean;
}

function isError(value: unknown, kind: string): boolean {
  return (
    value !== null && typeof value === "object" && (value as { error?: unknown }).error === kind
  );
}

/** Python refuses to normalize the note; TypeScript writes it. */
function typescriptWrites(difference: Difference, feature?: string): boolean {
  return (
    difference.comparison === "python-vs-compatible" &&
    difference.section === "normalize" &&
    isError(difference.python, "UnsupportedFrontmatter") &&
    typeof difference.typescript === "string" &&
    (feature === undefined || (difference.features ?? []).includes(feature))
  );
}

/** Canonical note text with any blank lines after the closing `---` reduced to one. */
function withoutBlankLinesAfterBlock(text: string): string {
  const end = text.startsWith("---\n---\n") ? 3 : text.indexOf("\n---\n", 4);
  if (end === -1) return text;
  const head = text.slice(0, end + 5);
  return `${head}${text.slice(end + 5).replace(/^\n+/, "\n")}`;
}

/** Canonical note text split into the frontmatter block (through `---`) and the body lines. */
function canonicalParts(text: string): { block: string; body: string[] } | null {
  const end = text.startsWith("---\n---\n") ? 3 : text.indexOf("\n---\n", 4);
  if (!text.startsWith("---\n") || end === -1) return null;
  return { block: text.slice(0, end + 5), body: text.slice(end + 5).split("\n") };
}

// The line breaks the canonical writer splits a body on.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these control characters are line breaks.
const BODY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/**
 * The TypeScript text is the Python text with a run of two or more spaces
 * added at the end of some body lines that have content, and each such line,
 * with its spaces, is a line of the note on disk. Nothing else differs.
 */
function onlyKeepsHardBreaks(python: string, typescript: string, original: string): boolean {
  const p = canonicalParts(python);
  const t = canonicalParts(typescript);
  if (p === null || t === null || p.block !== t.block || p.body.length !== t.body.length) {
    return false;
  }
  const sourceLines = new Set(original.split(BODY_LINE_BREAK));
  let kept = 0;
  for (const [i, line] of t.body.entries()) {
    const before = p.body[i] as string;
    if (line === before) continue;
    if (
      before === "" ||
      !line.startsWith(before) ||
      !/^ {2,}$/.test(line.slice(before.length)) ||
      !sourceLines.has(line)
    ) {
      return false;
    }
    kept++;
  }
  return kept > 0;
}

// A Python `repr` string literal, and a JSON one.
const PYTHON_STRING = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

function pythonString(literal: string): string {
  return literal
    .slice(1, -1)
    .replace(/\\(x[0-9a-f]{2}|u[0-9a-f]{4}|U[0-9a-f]{8}|.)/g, (_, code: string) => {
      if (code.length > 1) return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
      return { n: "\n", r: "\r", t: "\t" }[code] ?? code;
    });
}

/** The text around the string literals, and the literals' values. */
function quoted(text: string, literal: RegExp, decode: (literal: string) => string) {
  return {
    around: text.split(literal),
    values: (text.match(literal) ?? []).map(decode),
  };
}

/**
 * `python` and `typescript` are the same, except that strings may quote the
 * same string values as a Python `repr` and as JSON, respectively.
 */
function sameButQuoting(python: unknown, typescript: unknown): boolean {
  if (typeof python === "string" && typeof typescript === "string") {
    if (python === typescript) return true;
    const p = quoted(python, PYTHON_STRING, pythonString);
    const t = quoted(typescript, JSON_STRING, (literal) => JSON.parse(literal) as string);
    return p.values.length > 0 && isDeepStrictEqual(p, t);
  }
  if (Array.isArray(python) && Array.isArray(typescript)) {
    return (
      python.length === typescript.length &&
      python.every((item, i) => sameButQuoting(item, typescript[i]))
    );
  }
  if (python !== null && typeof python === "object" && typescript !== null) {
    if (typeof typescript !== "object" || Array.isArray(typescript)) return false;
    const keys = Object.keys(python).sort();
    return (
      isDeepStrictEqual(keys, Object.keys(typescript).sort()) &&
      keys.every((key) =>
        sameButQuoting(
          (python as Record<string, unknown>)[key],
          (typescript as Record<string, unknown>)[key],
        ),
      )
    );
  }
  return isDeepStrictEqual(python, typescript);
}

const WRITES =
  "The TypeScript normalizer parses it with the yaml Document API, keeps such " +
  "properties byte for byte, and returns text only after reading back the same " +
  "values and comments; the harness also checks that the output keeps the " +
  "values and does not change when normalized again.";

export const ALLOWLIST: AllowlistEntry[] = [
  {
    id: "block-scalar",
    reason: `Python refuses a block scalar (\`key: |\` or \`key: >\`). ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "block-scalar"),
  },
  {
    id: "comment",
    reason: `Python refuses a YAML comment. ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "comment"),
  },
  {
    id: "nested-collection",
    reason: `Python refuses a nested map or a list inside a list. ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "nested-collection"),
  },
  {
    id: "anchor-or-alias",
    reason: `Python refuses YAML anchors and aliases. ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "anchor-or-alias"),
  },
  {
    id: "quoted-typed-scalar",
    reason:
      'Python refuses a quoted value that bare YAML reads as a null, bool, or number ("true", "3"), ' +
      `because its serializer would drop the quotes. TypeScript keeps the quotes. ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "quoted-typed-scalar"),
  },
  {
    id: "quoted-key",
    reason:
      "Python refuses a quoted property name. TypeScript writes it bare when bare YAML " +
      `reads the same name, and keeps the quotes when it would not (\`"null"\`). ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "quoted-key"),
  },
  {
    id: "multi-line-scalar",
    reason: `Python refuses a plain or quoted value written across several lines. ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "multi-line-scalar"),
  },
  {
    id: "escape-sequence",
    reason: `Python refuses double-quoted escapes other than \\\\ and \\". ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "escape-sequence"),
  },
  {
    id: "tab-separator",
    reason: `Python refuses a tab in the block; YAML allows one as a separator. ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "tab"),
  },
  {
    id: "list-indent",
    reason:
      "Python reads list items only when indented by exactly two spaces (`  - item`); " +
      `YAML also allows other indents, such as \`- item\` under its key. ${WRITES}`,
    matches: (difference) => typescriptWrites(difference, "list-indent"),
  },
  {
    id: "body-leading-blank-line",
    reason:
      "When the body starts with a line of only spaces, Python writes it as an extra blank " +
      "line after `---`, which its own reader then drops, so normalizing again changes the " +
      "note. TypeScript drops that line, so normalizing is idempotent.",
    matches: (difference) =>
      difference.comparison === "python-vs-compatible" &&
      difference.section === "normalize" &&
      typeof difference.python === "string" &&
      typeof difference.typescript === "string" &&
      withoutBlankLinesAfterBlock(difference.python) === difference.typescript,
  },
  {
    id: "body-hard-line-break",
    reason:
      "Python trims all trailing whitespace from body lines, which deletes Markdown hard " +
      "line breaks (two or more spaces before a line ending) and changes how the note " +
      "renders. TypeScript keeps a final run of two or more spaces on a body line that " +
      "has content (kpeez/llmos#44). The texts must differ only in those runs.",
    matches: (difference) =>
      difference.comparison === "python-vs-compatible" &&
      difference.section === "normalize" &&
      typeof difference.python === "string" &&
      typeof difference.typescript === "string" &&
      typeof difference.text === "string" &&
      onlyKeepsHardBreaks(difference.python, difference.typescript, difference.text),
  },
  {
    id: "empty-frontmatter-block",
    reason:
      "A note that starts with `---` then `---` has an empty frontmatter block. Python " +
      "sees no block there (or takes the next `---` as its end), so its own canonical form of a note with no properties " +
      "could not be normalized again; TypeScript reads the empty block, so normalizing " +
      "is idempotent and a later stamp can add properties.",
    matches: (difference) =>
      difference.comparison === "python-vs-compatible" &&
      difference.section === "normalize" &&
      (isError(difference.python, "MissingFrontmatter") ||
        isError(difference.python, "UnsupportedFrontmatter")) &&
      typeof difference.typescript === "string" &&
      (difference.features ?? []).includes("empty-block"),
  },
  {
    id: "refusal-reason",
    reason:
      "Both refuse to rewrite the note. The TypeScript message names the YAML error; " +
      "the Python message names the line-parser rule.",
    matches: (difference) =>
      difference.comparison === "python-vs-compatible" &&
      difference.section === "normalize" &&
      isError(difference.python, "UnsupportedFrontmatter") &&
      isError(difference.typescript, "UnsupportedFrontmatter") &&
      // A refusal of valid YAML (the safety check in `toString`) is not intended.
      !String((difference.typescript as { message?: unknown }).message).startsWith(
        "refusing to rewrite",
      ),
  },
  {
    id: "health-qmd-unembedded",
    reason:
      "health gained qmd_unembedded (documents still needing embedding) when the Stop hook " +
      "stopped embedding; the Python health has no such field. It is null without qmd.",
    matches: (difference) =>
      difference.comparison === "python-vs-compatible" &&
      difference.section === "health.qmd_unembedded" &&
      difference.python === undefined &&
      (difference.typescript === null || typeof difference.typescript === "number"),
  },
  {
    id: "message-quotes-json",
    reason:
      "Finding and schema messages quote a value as JSON, not as a Python `repr` (message " +
      "wording is not contract); the quoted values and all other text must be equal.",
    matches: (difference) =>
      difference.comparison === "python-vs-compatible" &&
      ["check", "schema.errors", "health.schema_violations"].includes(difference.section) &&
      sameButQuoting(difference.python, difference.typescript),
  },
  {
    id: "created-not-yyyy-mm-dd",
    reason:
      "An inbox note whose `created` is not `YYYY-MM-DD` is stale, like one without a date " +
      "(Python also read `date.fromisoformat` forms such as `20261005` and `2026-W40-3`).",
    matches: (difference) => {
      if (
        difference.comparison !== "python-vs-compatible" ||
        difference.section !== "health.stale_inbox" ||
        !Array.isArray(difference.python) ||
        !Array.isArray(difference.typescript)
      ) {
        return false;
      }
      const python = new Set(difference.python as string[]);
      const typescript = new Set(difference.typescript as string[]);
      const extra = [...typescript].filter((path) => !python.has(path));
      const created = difference.created ?? {};
      return (
        extra.length > 0 &&
        [...python].every((path) => typescript.has(path)) &&
        extra.every((path) => {
          const value = created[path];
          return typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value);
        })
      );
    },
  },
  {
    id: "properties-python-cannot-read",
    reason:
      "Python reads a note whose frontmatter it refuses (or an empty block) as having " +
      "no properties; TypeScript reads the properties of valid YAML. The differences in read, list, " +
      "links, topic siblings, health, and the schema audit that follow from those " +
      "properties are intended. Each one is shown to follow from them: the run that " +
      "reads those notes as Python does matches Python with no other difference.",
    matches: (difference) => difference.comparison === "compatible-vs-full",
  },
];
