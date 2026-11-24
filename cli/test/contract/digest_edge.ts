/**
 * A generated vault and synthetic `gh` output for the digest contract test
 * (`digest.test.ts`). The days cover a created, an updated (CRLF, stale
 * hash, a thought), and an inserted block; a silent day; both DST changes;
 * and a failing day. The activity carries non-ASCII, astral, and
 * lone-surrogate text, a raw U+2028, quotes, nested and non-ASCII keys, a PR
 * merged on the day it was opened, a PR opened in one repository on the day
 * a PR with the same number merged in another, and gh's year-1 `closedAt` for open issues. Special
 * characters are built from code points so the source stays ASCII.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const c = (...codes: number[]): string => String.fromCodePoint(...codes);
const EM_DASH = c(0x2014);
const GRIN = c(0x1f600);
const LINE_SEPARATOR = c(0x2028);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const U_UMLAUT = c(0xfc);

/** The days the contract test runs, in order, with the outcome each exists to cover. */
export const EDGE_DAYS: [string, string][] = [
  ["2026-07-16", "created"],
  ["2026-07-17", "updated"],
  ["2026-07-18", "updated"],
  ["2026-07-19", "silent (no note created)"],
  ["2026-03-08", "created"],
  ["2026-11-01", "created"],
  ["2026-07-21", "created"],
  ["2026-07-20", "failed"],
];

const TEMPLATE =
  '---\nstatus: active\ncreated: "{{date:YYYY-MM-DD}}"\nupdated: "{{date:YYYY-MM-DD}}"\n' +
  'categories:\n  - "[[Reviews]]"\n---\n\n# {{date:YYYY-MM-DD}}\n\n## Thoughts\n\n## Projects\n\n' +
  "<!-- llmos-activity:start -->\n<!-- llmos-activity:end -->\n\n" +
  "![[Daily Reviews.base#Created on day]]\n";

const landing = (status: string, body: string): string => `---\nstatus: ${status}\n---\n\n${body}`;

const FILES: Record<string, string> = {
  "AGENTS.md": "# Digest edge vault\n",
  "categories/templates/daily-note.md": TEMPLATE,
  // Monitored. The title is non-ASCII and comes after a `##` line.
  "projects/alpha/alpha.md": landing(
    "active",
    `## Intro\n\n#  Alpha ${EM_DASH} ${U_UMLAUT}nicode ${GRIN}  \n\nText.\n`,
  ),
  // Monitored through a case-insensitive repository match (example-org/Beta).
  "projects/beta/beta.md": landing("active", "# Beta\n"),
  // Active without a repository: listed as not monitored, in Path order (a, a-b).
  "projects/a/a.md": landing("active", "# A\n"),
  "projects/a-b/a-b.md": landing("active", "No heading.\n"),
  "projects/gamma/gamma.md": landing('"active"', "# Gamma\n"),
  // Not monitored: archived, a YAML error, a note whose name is not the folder's.
  "projects/delta/delta.md": landing("archived", "# Delta\n"),
  "projects/eta/eta.md": "---\nstatus: active\nbroken: [\n---\n\n# Eta\n",
  "projects/theta/notes.md": landing("active", "# Theta notes\n"),
  // An existing note with CRLF line endings, a stale hash, and a thought.
  "daily/2026-07-17.md":
    "---\r\nstatus: active\r\n---\r\n\r\n# 2026-07-17\r\n\r\n## Thoughts\r\n\r\nKeep me.\r\n\r\n" +
    `## Projects\r\n\r\n<!-- llmos-activity:start hash=${"0".repeat(64)} -->\r\nstale\r\n` +
    "<!-- llmos-activity:end -->\r\n",
  // An existing note with a Projects heading and no markers.
  "daily/2026-07-18.md": "# 2026-07-18\n\n## Projects\n\n## Later\n\nKeep.\n",
};

export function writeDigestEdgeVault(root: string): void {
  for (const [path, text] of Object.entries(FILES)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  mkdirSync(join(root, ".obsidian"), { recursive: true });
}

/** The repositories of each configured GitHub owner. */
export const ORG_REPOS: Record<string, string[]> = {
  kpeez: ["kpeez/alpha", "kpeez/dotfiles"],
  "example-org": ["example-org/Beta", "example-org/other"],
};

type Item = Record<string, unknown>;
const pr = (repo: string, number: number, title: string, body: string): Item => ({
  body,
  number,
  repository: { name: repo.split("/")[1], nameWithOwner: repo },
  state: "MERGED",
  title,
  url: `https://github.com/${repo}/pull/${number}`,
});
const issue = (repo: string, number: number, createdAt: string, closedAt: string): Item => ({
  ...pr(repo, number, `Issue ${number}`, `Body of ${number}.`),
  closedAt,
  createdAt,
  state: closedAt.startsWith("0001") ? "OPEN" : "CLOSED",
  url: `https://github.com/${repo}/issues/${number}`,
});
const commit = (repo: string, sha: string, date: string): Item => ({
  commit: {
    author: { date, email: "a@example.com", name: `Ren${c(0xe9)}` },
    comment_count: 0,
    message: `Commit ${sha}\n\nWith "quotes" and a tab\there.`,
    tree: { sha: `${sha}tree` },
  },
  repository: { fullName: repo, id: "R_1", isFork: false, isPrivate: true, name: "x" },
  sha,
  url: `https://github.com/${repo}/commit/${sha}`,
});
const OPEN = "0001-01-01T00:00:00Z";

type Day = { merged: Item[]; opened: Item[]; issues: Item[]; commits: Item[] };
const empty = (): Day => ({ merged: [], opened: [], issues: [], commits: [] });

const DAYS: Record<string, Day> = {
  "2026-07-16": {
    merged: [
      pr(
        "kpeez/alpha",
        12,
        `Add gate${LINE_SEPARATOR}fast ${GRIN}`,
        `Adds the "hash" gate \\ ${EM_DASH} ${LONE_SURROGATE} done.`,
      ),
    ],
    opened: [
      pr("kpeez/alpha", 12, "Add gate", "Opened and merged the same day."),
      pr("example-org/Beta", 3, "Beta work", `Body with ${c(0x430, 0x431)} and\nlines.`),
    ],
    issues: [
      // 22:30 local on the 16th, already the 17th in UTC.
      issue("kpeez/alpha", 5, "2026-07-17T05:30:00Z", OPEN),
      issue("kpeez/alpha", 6, "2026-07-01T10:00:00Z", "2026-07-16T18:00:00Z"),
      issue("example-org/Beta", 8, "2026-07-01T10:00:00Z", OPEN),
      {
        ...issue("example-org/Beta", 9, "2026-07-16T12:00:00Z", OPEN),
        [c(0x43a)]: { b: 1, a: [] },
      },
    ],
    commits: [
      commit("kpeez/alpha", "abc123", "2026-07-16T10:00:00.000-07:00"),
      commit("example-org/Beta", "def456", "2026-07-16T11:00:00Z"),
    ],
  },
  "2026-07-17": {
    ...empty(),
    merged: [pr("example-org/Beta", 4, "Beta fix", "")],
    commits: [commit("example-org/Beta", "aaa111", "2026-07-17T09:00:00Z")],
  },
  "2026-07-18": { ...empty(), commits: [commit("kpeez/alpha", "bbb222", "2026-07-18T09:00:00Z")] },
  "2026-07-19": empty(),
  "2026-03-08": {
    ...empty(),
    issues: [
      issue("kpeez/alpha", 20, "2026-03-08T07:59:59Z", OPEN), // 23:59:59 PST on the 7th: out
      issue("kpeez/alpha", 21, "2026-03-08T08:00:00Z", OPEN), // 00:00 PST on the 8th: in
      issue("kpeez/alpha", 22, "2026-03-09T06:59:59Z", OPEN), // 23:59:59 PDT on the 8th: in
      issue("kpeez/alpha", 23, "2026-03-09T07:00:00Z", OPEN), // 00:00 PDT on the 9th: out
    ],
  },
  "2026-11-01": {
    ...empty(),
    issues: [
      issue("kpeez/alpha", 30, "2026-11-01T06:59:59Z", OPEN), // 23:59:59 PDT on Oct 31: out
      issue("kpeez/alpha", 31, "2026-11-01T07:00:00Z", OPEN), // 00:00 PDT: in
      issue("kpeez/alpha", 32, "2026-11-02T07:59:59Z", OPEN), // 23:59:59 PST: in
      issue("kpeez/alpha", 33, "2026-11-02T08:00:00Z", OPEN), // 00:00 PST on Nov 2: out
    ],
  },
  // alpha #40 merged today and was opened today, so it is not listed as
  // opened. Beta's own #40, opened today and still open, is listed.
  "2026-07-21": {
    ...empty(),
    merged: [pr("kpeez/alpha", 40, "Merge same day", "Opened and merged.")],
    opened: [
      pr("kpeez/alpha", 40, "Merge same day", "Opened and merged."),
      { ...pr("example-org/Beta", 40, "Beta draft", "Still open."), state: "OPEN" },
    ],
  },
  "2026-07-20": { ...empty(), merged: [pr("kpeez/dotfiles", 1, "Rogue", "Not a project.")] },
};

/** The synthetic `gh` result for one call, chosen from its arguments. */
export function edgeGh(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const ok = (value: unknown) => ({
    stdout: `${JSON.stringify(value)}\n`,
    stderr: "",
    exitCode: 0,
  });
  if (args[0] === "repo" && args[1] === "list") {
    return ok((ORG_REPOS[args[2] as string] ?? []).map((nameWithOwner) => ({ nameWithOwner })));
  }
  const qualifiers = ["--merged-at", "--created", "--updated", "--author-date"];
  const at = args.findIndex((arg) => qualifiers.includes(arg));
  const day = DAYS[(args[at + 1] ?? "").slice(0, 10)];
  if (args[0] !== "search" || at === -1 || day === undefined) {
    return {
      stdout: "",
      stderr: `edge gh: unexpected call ${JSON.stringify(args)}\n`,
      exitCode: 1,
    };
  }
  const kind = `${args[1]} ${args[at]}`;
  if (kind === "prs --merged-at") return ok(day.merged);
  if (kind === "prs --created") return ok(day.opened);
  if (kind === "issues --updated") return ok(day.issues);
  if (kind === "commits --author-date") return ok(day.commits);
  return { stdout: "", stderr: `edge gh: unexpected search ${kind}\n`, exitCode: 1 };
}
