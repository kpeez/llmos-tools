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
 *   `normalize` results may differ here.
 * - `compatible-vs-full`: that run against the real TypeScript run. The two
 *   differ only in the properties of the notes Python refuses, so every
 *   difference here follows from reading those properties.
 */

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
