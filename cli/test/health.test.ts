/** False positives of `llmos-vault health`, on temporary vaults (never the real one). */

import { describe, expect, test } from "bun:test";
import { VaultModel } from "../src/vault.ts";
import { cli, makeVault } from "./helpers.ts";

interface Report {
  orphans: string[];
  dead_ends: string[];
  unresolved_links: { referrer: string; target: string }[];
  stale_inbox: string[];
}

async function health(files: Record<string, string>, args: string[] = []): Promise<Report> {
  const result = await cli(makeVault(files), ["health", "--json", ...args]);
  const report = JSON.parse(result.stdout) as Report;
  // The shared test vault's daily template links `[[Reviews]]`, a category hub
  // these tests do not create. That is a real missing link, so both profiles
  // report it; the helper drops it to keep each test's expectations about its
  // own notes.
  report.unresolved_links = report.unresolved_links.filter(
    (link) => link.referrer !== "categories/templates/daily-note.md",
  );
  return report;
}

const FRONT = '---\ncreated: "2026-10-01"\n---\n\n';

describe("health: links to non-note files", () => {
  test("an embed of an existing file resolves by path or file name; a missing file stays unresolved", async () => {
    const report = await health({
      "notes/a.md": `${FRONT}![[Topics.base#Topic members]] ![[categories/Vault.base]] ![[plot.PNG|300]]\n![[Gone.base]] ![[bases/Topics.base]]\n`,
      "categories/Topics.base": "views: []\n",
      "categories/Vault.base": "views: []\n",
      "assets/plot.png": "x",
    });
    expect(report.unresolved_links.map((link) => link.target)).toEqual([
      "Gone.base",
      "bases/Topics.base",
    ]);
  });
});

describe("health: wikilinks in code", () => {
  test("fenced blocks and inline spans hold no links; a link beside them stays", async () => {
    const report = await health({
      "notes/a.md": [
        FRONT,
        "```bash",
        '[[ -s "$NVM_DIR/nvm.sh" ]]',
        "```",
        "~~~~python",
        "[[1, 2], [3, 4]]",
        "```",
        "[[still code]]",
        "~~~~",
        "Inline `[[x,y]]` and ``[[a`b]]`` code, then [[Real Missing]].",
        "",
        "```",
        "[[unclosed fence]]",
      ].join("\n"),
    });
    expect(report.unresolved_links).toEqual([{ referrer: "notes/a.md", target: "Real Missing" }]);
  });
});

describe("health: code spans follow CommonMark", () => {
  const targets = async (body: string): Promise<string[]> =>
    (await health({ "notes/a.md": `${FRONT}${body}\n` })).unresolved_links.map(
      (link) => link.target,
    );

  test("a backslash-escaped backtick opens no span, so a link after it is seen", async () => {
    expect(await targets("Escaped \\`not code [[Real]] and `x`.")).toEqual(["Real"]);
  });

  test("a stray backtick before a fence hides nothing after the fence", async () => {
    expect(await targets("Use ` here.\n```\n[[Hidden]]\n```\n[[Real]] and `x`.")).toEqual(["Real"]);
  });

  test("a double-backtick span may hold a single backtick and hides its link", async () => {
    expect(await targets("``x ` [[Hidden]] ``, then [[Real]].")).toEqual(["Real"]);
  });

  test("a span may cross a single newline, so the link inside it is hidden", async () => {
    expect(await targets("`first\n[[Hidden]] line` then [[Real]].")).toEqual(["Real"]);
  });

  test("a heading ends the paragraph, so a stray backtick above it does not hide a link below", async () => {
    expect(await targets("Stray `tick\n# Heading\nSee [[Real]] and `x`.")).toEqual(["Real"]);
  });
});

describe("health: fence closing rules", () => {
  const targets = async (body: string): Promise<string[]> =>
    (await health({ "notes/a.md": `${FRONT}${body}\n` })).unresolved_links.map(
      (link) => link.target,
    );

  test("only a fence of the same character and at least the same length closes the block", async () => {
    expect(await targets("```\n[[Hidden]]\n````\n[[Real]]")).toEqual(["Real"]);
    expect(await targets("````\n```\n[[Hidden]]\n````\n[[Real]]")).toEqual(["Real"]);
    expect(await targets("```\n~~~\n[[Hidden]]\n```\n[[Real]]")).toEqual(["Real"]);
  });
});

describe("health: category values that are not a hub link", () => {
  const categoryFiles = (front: string): Record<string, string> => ({
    "categories/Reviews.md": `${FRONT}# Reviews\n`,
    "daily/2026-10-05.md": `---\ncreated: "2026-10-05"\n${front}---\n\n# Day\n`,
  });

  test("a scalar or bare-string category is not a valid category, so the note stays an orphan", async () => {
    for (const front of ['categories: "[[Reviews]]"', "categories: [Reviews]"]) {
      const report = await health(categoryFiles(front));
      expect(report.orphans).toContain("daily/2026-10-05.md");
    }
  });
});

describe("health: dot folders are not vault files", () => {
  test("an image and a note under .trash/ are not link targets", async () => {
    const report = await health({
      "notes/a.md": `${FRONT}![[old.png]] [[Old Note]]\n`,
      ".trash/old.png": "x",
      ".trash/Old Note.md": `${FRONT}# Old\n`,
    });
    expect(report.unresolved_links).toEqual([
      { referrer: "notes/a.md", target: "Old Note" },
      { referrer: "notes/a.md", target: "old.png" },
    ]);
  });
});

describe("health: the inbox", () => {
  const old = '---\ncreated: "2026-09-01"\n---\n\n# Capture\n';

  test("is every note in raw/ but a captured source's raw/<slug>/source.md", async () => {
    const report = await health({
      "raw/capture.md": old,
      "raw/batch/note.md": old,
      "raw/arxiv-1/source.md": old,
    });
    expect(report.stale_inbox).toEqual(["raw/batch/note.md", "raw/capture.md"]);
    expect(report.orphans).toContain("raw/capture.md");
  });

  test("is the inbox/ folder in the core profile", async () => {
    const report = await health({ "inbox/capture.md": old, "raw/capture.md": old }, [
      "--vault",
      "second-vault",
    ]);
    expect(report.stale_inbox).toEqual(["inbox/capture.md"]);
  });
});

/** Front matter that files a note under the category hub `hub`. */
const filed = (hub: string): string =>
  `---\ncreated: "2026-10-01"\ncategories:\n  - "[[${hub}]]"\n---\n\n`;

describe("health: orphans and categories", () => {
  test("daily notes filed under the Reviews hub are no orphans, while an unfiled one is an orphan and a dead-end", async () => {
    const report = await health({
      "categories/Reviews.md": `${FRONT}# Reviews\n`,
      "daily/2026-10-01.md": `${filed("Reviews")}# Day\n`,
      "daily/2026-10-02.md": `${filed("Reviews")}# Day\n\n[[Nowhere]]\n`,
      "daily/2026-10-03.md": `${FRONT}# Day\n`,
      "notes/loose.md": `${FRONT}# Loose\n\n[[loose-target]]\n`,
      "notes/loose-target.md": `${FRONT}# Target\n\n[[loose]]\n`,
      "notes/orphan.md": `${FRONT}# Orphan\n\n[[loose]]\n`,
    });
    expect(report.orphans).toContain("notes/orphan.md");
    expect(report.orphans).not.toContain("daily/2026-10-01.md");
    expect(report.orphans).not.toContain("daily/2026-10-02.md");
    expect(report.orphans).toContain("daily/2026-10-03.md");
    expect(report.dead_ends).toContain("daily/2026-10-03.md");
    expect(report.unresolved_links).toEqual([
      { referrer: "daily/2026-10-02.md", target: "Nowhere" },
    ]);
  });

  test("a note whose category names a missing hub is an orphan, daily notes too", async () => {
    const report = await health({
      "notes/misfiled.md": `${filed("Nowhere")}# Misfiled\n`,
      "daily/2026-10-04.md": `${filed("Reviews")}# Day\n`,
    });
    expect(report.orphans).toContain("notes/misfiled.md");
    expect(report.orphans).toContain("daily/2026-10-04.md");
  });

  test("the core profile counts backlinks only: a filed note and the inbox hub are orphans", async () => {
    const report = await health(
      {
        "categories/Papers.md": `${FRONT}# Papers\n`,
        "notes/filed.md": `${filed("Papers")}# Filed\n`,
        "inbox/Inbox.md": "# Inbox\n",
      },
      ["--vault", "second-vault"],
    );
    expect(report.orphans).toContain("notes/filed.md");
    expect(report.orphans).toContain("inbox/Inbox.md");
  });
});

describe("health: notes that share a file name", () => {
  test("report paths, so only the note that is really an orphan or a dead-end is named", async () => {
    const report = await health({
      "notes/linker.md": `${FRONT}[[projects/one/README]] [[Missing]]\n`,
      "projects/one/README.md": `${FRONT}[[notes/linker]]\n`,
      "projects/two/README.md": `${FRONT}[[notes/linker]]\n`,
      "projects/three/README.md": `${FRONT}# No links\n`,
    });
    expect(report.orphans).toContain("projects/two/README.md");
    expect(report.orphans).not.toContain("projects/one/README.md");
    expect(report.dead_ends).toContain("projects/three/README.md");
    expect(report.dead_ends).not.toContain("projects/two/README.md");
    expect(report.unresolved_links).toEqual([{ referrer: "notes/linker.md", target: "Missing" }]);
  });
});

describe("health: the templates folder is scaffolding in the llmos vault", () => {
  const meeting = `${FRONT}# {{title}}\n`;
  const project = `${FRONT}# {{title}}\n\n![[{{title}}.base]]\n[[{{date:YYYY-MM-DD}}]]\n`;

  test("a template with no inbound or outgoing link is no orphan and no dead-end", async () => {
    const report = await health({ "categories/templates/Meeting.md": meeting });
    expect(report.orphans).not.toContain("categories/templates/Meeting.md");
    expect(report.dead_ends).not.toContain("categories/templates/Meeting.md");
  });

  test("a template's placeholder links, such as a {{title}}.base embed, are no unresolved links", async () => {
    const report = await health({ "categories/templates/Project.md": project });
    expect(report.unresolved_links).toEqual([]);
  });

  test("a note that links a template still resolves it", async () => {
    const report = await health({
      "categories/templates/Meeting.md": meeting,
      "notes/a.md": `${FRONT}[[Meeting]] [[Gone]]\n`,
    });
    expect(report.orphans).not.toContain("categories/templates/Meeting.md");
    expect(report.unresolved_links).toEqual([{ referrer: "notes/a.md", target: "Gone" }]);
  });

  test("a template's real missing link is still reported", async () => {
    const report = await health({
      "categories/templates/Meeting.md": `${FRONT}# {{title}}\n\n[[Missing Note]]\n`,
    });
    expect(report.unresolved_links).toEqual([
      { referrer: "categories/templates/Meeting.md", target: "Missing Note" },
    ]);
  });

  test("a link from a template is no inbound link, so its target stays an orphan", async () => {
    const report = await health({
      "categories/templates/Meeting.md": `${FRONT}# {{title}}\n\n[[Target]]\n`,
      "notes/Target.md": `${FRONT}# Target\n`,
    });
    expect(report.orphans).toContain("notes/Target.md");
    expect(report.unresolved_links).toEqual([]);
  });

  test("only the root categories/templates/ folder is scaffolding, so other folders named templates are not skipped", async () => {
    const report = await health({
      "templates-foo.md": `${FRONT}# Foo\n`,
      "projects/x/templates/note.md": `${FRONT}![[{{title}}.base]]\n`,
    });
    expect(report.orphans).toContain("templates-foo.md");
    expect(report.dead_ends).toContain("templates-foo.md");
    expect(report.orphans).toContain("projects/x/templates/note.md");
    expect(report.unresolved_links).toEqual([
      { referrer: "projects/x/templates/note.md", target: "{{title}}.base" },
    ]);
  });

  test("the core profile reports a template's orphan, dead-end, and placeholder links", async () => {
    const report = await health(
      { "categories/templates/Meeting.md": meeting, "categories/templates/Project.md": project },
      ["--vault", "second-vault"],
    );
    expect(report.orphans).toContain("categories/templates/Meeting.md");
    expect(report.dead_ends).toContain("categories/templates/Meeting.md");
    expect(report.unresolved_links).toEqual([
      { referrer: "categories/templates/Project.md", target: "{{date:YYYY-MM-DD}}" },
      { referrer: "categories/templates/Project.md", target: "{{title}}.base" },
    ]);
  });
});

describe("health: shared project memory notes", () => {
  test("are never flagged as orphans, dead-ends, or unresolved-link referrers, and stay in VaultModel", async () => {
    const files = {
      "projects/demo/demo.md": `${FRONT}# Demo\n\n[[projects/demo/notes/linked]]\n`,
      "projects/demo/notes/linked.md": `${FRONT}[[demo]]\n`,
      "projects/demo/notes/only-in-memory.md": `${FRONT}# Only In Memory\n\n[[demo]]\n`,
      "projects/demo/memory/MEMORY.md": "# Memory\n\n- [[demo]]\n- [[missing-slug]]\n",
      "projects/demo/memory/topic.md":
        "---\nname: Topic\ndescription: Note\nmetadata:\n  type: project\n---\n\nSee [[only-in-memory]] and [[unresolved-breadcrumb]].\n",
    };
    const root = makeVault(files);
    const model = VaultModel.load(root);
    expect(model.notes.map((n) => n.path)).toContain("projects/demo/memory/MEMORY.md");
    expect(model.notes.map((n) => n.path)).toContain("projects/demo/memory/topic.md");

    const report = await health(files);
    expect(report.orphans).not.toContain("projects/demo/memory/MEMORY.md");
    expect(report.orphans).not.toContain("projects/demo/memory/topic.md");
    expect(report.dead_ends).not.toContain("projects/demo/memory/MEMORY.md");
    expect(report.dead_ends).not.toContain("projects/demo/memory/topic.md");
    expect(report.unresolved_links).toEqual([]);
    // A link from a memory note does not exempt a durable note from orphan checks.
    expect(report.orphans).toContain("projects/demo/notes/only-in-memory.md");
  });
});
