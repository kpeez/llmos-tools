/**
 * A generated vault of resolver, frontmatter, schema, inbox, and authoring
 * edge cases, so the contract snapshots cover more than the fixture vaults.
 * Special characters are built from code points so the source stays ASCII.
 */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const c = (...codes: number[]): string => String.fromCodePoint(...codes);
const LINE_SEPARATOR = c(0x2028);
const NBSP = c(0xa0);
const ASTRAL = c(0x1d518); // MATHEMATICAL FRAKTUR CAPITAL U
const E_ACUTE = c(0xe9);

const note = (fm: string, body: string): string => `---\n${fm}---\n\n${body}`;

const NOTES: Record<string, string> = {
  "AGENTS.md": "# Edge vault\n",
  ".obsidian/ignored.md": "# Never indexed [[alpha]]\n",
  ".trash/discarded.md": note("created: 2026-07-01\n", "Links to [[alpha]].\n"),

  // Resolver: root note beside a nested note with the same name, case-insensitively.
  "llmOS.md": note(
    "created: 2026-07-01\n",
    "# Root\n\nSee [[projects/llmos/llmos|the project]].\n",
  ),
  "projects/llmos/llmos.md": note(
    'categories:\n  - "[[Projects]]"\ncreated: 2026-07-01\n',
    "# llmOS\n\nBack to [[llmOS]] and [[llmos]].\n",
  ),
  // Ambiguous basenames of equal path length; same-folder and shortest-path tie-breaks.
  "a/dup.md": note("created: 2026-07-01\n", "A dup.\n"),
  "b/dup.md": note("created: 2026-07-01\n", "B dup.\n"),
  "a/linker.md": note("created: 2026-07-01\n", "Same folder [[dup]], explicit [[b/dup]].\n"),
  "c/linker2.md": note("created: 2026-07-01\n", "Ambiguous [[dup]] and [[DUP]].\n"),
  "x/short.md": note("created: 2026-07-01\n", "Short.\n"),
  "x/yy/short.md": note("created: 2026-07-01\n", "Longer.\n"),
  "z/uses-short.md": note("created: 2026-07-01\n", "Shortest wins [[short]].\n"),
  // Dotted names resolve to their own note.
  "notes/AGENTS.v2.md": note("created: 2026-07-01\n", "Version two.\n"),
  "human/sam3.1-fine-tune.md": note("created: 2026-07-01\n", "Fine tune.\n"),
  "notes/dotted-links.md": note(
    "created: 2026-07-01\n",
    "[[AGENTS.v2]] [[human/sam3.1-fine-tune]] [[sam3.1-fine-tune]] [[AGENTS]]\n",
  ),
  // Link syntax: .md suffix, heading, alias, table-escaped alias, case, self, embeds.
  "notes/alpha.md": note(
    "created: 2026-07-01\ntopics:\n  - gardening\n",
    "# Alpha\n\n[[notes/alpha.md]] [[beta#Heading|label]] [[ALPHA]] ![[beta]]\n\n" +
      "| a | b |\n| - | - |\n| [[beta\\|escaped]] | [[ghost note]] |\n",
  ),
  "notes/beta.md": note(
    'created: 2026-07-01\ntopics: [gardening, "b, c"]\nproject:\n  - "[[projects/llmos/llmos|llmOS]]"\n',
    "# Beta\n\n## Heading\n\nNo body links.\n",
  ),
  "notes/gamma.md": note('created: 2026-07-01\ntopics: "b, c"\n', "# Gamma\n"),
  [`notes/caf${E_ACUTE}.md`]: note("created: 2026-07-01\n", `Accented [[notes/alpha]].\n`),
  [`notes/${ASTRAL}nicode.md`]: note(
    "created: 2026-07-01\n",
    `${ASTRAL}${ASTRAL} before a reference: notes/alpha.md and [[caf${E_ACUTE}]].\n`,
  ),
  // Path ordering: "a-c.md" sorts after "a/..." by component, before it as a string.
  "a-c.md": note("created: 2026-07-01\n", "[[a/dup]]\n"),

  // Frontmatter shapes the parser accepts.
  "fm/messy.md": note(
    "updated: 2026-07-17\ncreated: \"2026-07-16\"\nauthors: [claude, 'co''dex']\nempty:\nnone: []\n" +
      'quoted: "say \\"hi\\" \\\\ there"\ncomma: [a, "b, c", ]\nkey with space: v\n',
    "# Messy   \n\n\nBody line with trailing spaces   \n\n\n\n",
  ),
  "fm/needs-quotes.md": note(
    'a: "[[Knowledge]]"\nb: "x: y"\nc: "x #y"\nd: "- x"\ne: "`code`"\nf: "end:"\ng: "@at"\n',
    "body\n",
  ),
  "fm/body-separators.md": note(
    "created: 2026-07-01\n",
    `line one${LINE_SEPARATOR}line two\fform feed\x1cgroup${NBSP}\n`,
  ),
  "fm/crlf.md": "---\r\ncreated: 2026-07-01\r\n---\r\n\r\n# CRLF\r\n",
  "fm/empty-block.md": "---\n\n---\n\n# Empty block\n",
  "fm/never-closed.md": "---\n---\n# Never closed\n",
  "fm/no-frontmatter.md": "# No frontmatter [[alpha]]\n",
  "fm/bom.md": `${c(0xfeff)}---\ncreated: 2026-07-01\n---\n\n# BOM\n`,

  // Frontmatter shapes the retired Python parser refused. The TypeScript
  // reader takes the valid YAML among them (and its property links) and
  // refuses the rest, whose links in the block must not count.
  "fm/block-scalar.md": note("method: |\n  see [[alpha]]\n", "# Block [[beta]]\n"),
  "fm/comment.md": note("status: active # revisit\n", "# Comment\n"),
  "fm/nested.md": note("nested:\n  key: value\n", "# Nested\n"),
  "fm/anchor.md": note("a: &x one\nb: *x\n", "# Anchor\n"),
  "fm/tab.md": note("a:\tb\n", "# Tab\n"),
  "fm/typed.md": note('flag: "true"\n', "# Typed\n"),
  "fm/unquoted-wikilink.md": note("project: [[X]]\n", "# Unquoted\n"),
  "fm/escape.md": note('a: "x\\ny"\n', "# Escape\n"),
  "fm/item-after-flow.md": note("a: [x]\n  - y\n", "# Item after flow\n"),
  "fm/line-separator.md": note(`a: x${LINE_SEPARATOR}b: y\n`, "# Separator\n"),
  "fm/duplicate.md": note("a: x\na: y\n", "# Duplicate\n"),
  "fm/top-level-item.md": note("tags:\n- top\n", "# Top-level item\n"),

  "fm/empty-item.md": note("a:\n  -\n  - x\n", "# Empty item\n"),
  "fm/quoted-typed-key.md": note('"null": y\na: x\n', "# Quoted key\n"),
  "fm/folded.md": note("z: >-\n  a long\n  paragraph\ntopics:\n  - gardening\n", "# Folded\n"),
  "fm/multi-line.md": note("title: one\n  two\n", "# Multi-line\n"),
  "fm/double-marker.md": "---\n---\nstatus: draft\n---\n# Double marker\n",
  "fm/leading-space-body.md": note("created: 2026-07-01\n", "   \n# Leading space\n"),
  "fm/nested-link.md": note('source:\n  note: "[[beta]]"\n', "# Nested link\n"),

  // Schema audit.
  "templates/skip.md": "# Skipped\n",
  "archive/old.md": "# Archived note\n",
  "skills/tool/SKILL.md": note("name: tool\n", "# Missing description\n"),
  "reviews/daily/2026-10-01.md": note(
    'created: 2026-10-01\nproject:\n  - "[[projects/llmos/llmos|llmOS]]"\n',
    "# 2026-10-01\n\n<!-- llmos-activity:start hash=abc -->\n<!-- llmos-activity:end -->\n",
  ),
  "reviews/daily/2026-10-02.md": note("created: 10/02/2026\n", "# 2026-10-02\n"),
  "projects/demo/notes/unowned.md": note(
    "status: someday\nauthors: [claude, robot]\ntype: x\ncategories: Knowledge\n" +
      'topics:\n  - plain\n  - "[[ok]]"\nblank:\n',
    "# Unowned\n",
  ),
  "projects/demo/demo.md": note('categories:\n  - "[[Projects]]"\n', "# Demo Project\n"),
  // A category must name a hub in categories/: Projects has one, Papers has none.
  "categories/Projects.md": note("tags:\n  - categories\n", "# Projects\n"),
  "knowledge/unhubbed.md": note(
    'created: 2026-07-01\ncategories:\n  - "[[Projects]]"\n  - "[[Papers]]"\n',
    "# Unhubbed\n",
  ),

  // Inbox staleness, including ISO week dates and invalid dates.
  "inbox/fresh.md": note("created: 2026-10-06\n", "Fresh.\n"),
  "inbox/stale.md": note("created: 2026-01-01\n", "Stale.\n"),
  "inbox/week-date.md": note("created: 2026-W40-3\n", "Week date.\n"),
  "inbox/basic-date.md": note("created: 20261005\n", "Basic date.\n"),
  "inbox/invalid-date.md": note("created: 2026-02-30\n", "Invalid.\n"),
  "inbox/trailing-date.md": note("created: 20261005xx\n", "Trailing characters.\n"),
  "inbox/week-date-tail.md": note("created: 2026W403xx\n", "Week date, trailing.\n"),
  "inbox/no-created.md": note("status: draft\n", "No created.\n"),
  "inbox/nested/deep.md": "# No frontmatter\n",

  // Authoring check: references in prose, code, comments, URLs, and links.
  "notes/references.md": note(
    "created: 2026-07-01\n",
    [
      "# References",
      "",
      "Prose mentions notes/alpha.md and beta.md and dup.md.",
      "Inline `notes/gamma.md` and `uv run x.md` and `../notes/alpha.md`.",
      "Relative ../notes/beta.md path.",
      "Already linked [beta](beta.md) and [caf](notes/caf%C3%A9.md).",
      "A URL https://example.org/notes/alpha.md is ignored.",
      "<!-- notes/gamma.md in a comment -->",
      "%% notes/gamma.md in an Obsidian comment %%",
      "",
      "```",
      "notes/gamma.md in a fence",
      "```",
      "",
      "    notes/gamma.md indented code",
      "",
      "- item",
      "    - nested item with notes/gamma.md",
      "\t- tab item with llmOS.md",
      "",
      "Self reference references.md, missing ghost.md, wikilinked [[gamma]].",
      "",
    ].join("\n"),
  ),
};

/** Write the edge-case vault under `root`, which must not exist yet. */
export function writeEdgeVault(root: string): void {
  for (const [path, text] of Object.entries(NOTES)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  // A symlinked note: `check` works on the link's target.
  mkdirSync(join(root, "links"), { recursive: true });
  symlinkSync("../notes/references.md", join(root, "links/alias.md"));
}
