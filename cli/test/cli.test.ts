import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { renderHelp } from "../src/cli.ts";
import { COMMANDS, DEFAULT_REFERENCE_PATH, DEFAULT_SKILL_PATH } from "../src/commands.ts";
import { renderReference, renderSkill } from "../src/docs.ts";
import { cli, dailyNote, makeVault, read, recordedObsidian, TODAY } from "./helpers.ts";

const DAILY = `daily/${TODAY}.md`;
const ALPHA =
  "---\ncreated: 2026-07-01\nstatus: draft\nauthors:\n  - human\n---\n\n# Alpha\n\nBody.\n";

describe("docs", () => {
  test("the committed command reference and skill verb table match the registry", () => {
    // Regenerate with `bun bin/llmos-vault.ts docs` when this fails.
    expect(readFileSync(DEFAULT_REFERENCE_PATH, "utf8")).toBe(renderReference(COMMANDS));
    const skill = readFileSync(DEFAULT_SKILL_PATH, "utf8");
    expect(renderSkill(skill, COMMANDS)).toBe(skill);
  });

  test("every command name of the retired Python CLI is still registered", () => {
    const names = COMMANDS.map((command) => command.name);
    for (const name of [
      "read",
      "list",
      "check",
      "neighbors",
      "subgraph",
      "health",
      "create",
      "move",
      "append",
      "set-property",
      "remove-property",
      "file-inbox",
      "daily get-or-create",
      "daily append-thought",
      "daily recent",
      "docs",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("--help prints the same text the reference shows", async () => {
    const result = await cli(makeVault(), ["daily", "append-thought", "--help"]);
    const command = COMMANDS.find((c) => c.name === "daily append-thought");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${renderHelp(command as (typeof COMMANDS)[number])}\n`);
  });
});

describe("command line", () => {
  test("usage errors exit 2 and name the command", async () => {
    const root = makeVault();
    for (const argv of [
      ["nope"],
      ["read"],
      ["subgraph", "x", "--depth", "two"],
      ["read", "x", "--vault", "other"],
      ["read", "x", "--bogus"],
      ["daily", "nope"],
    ]) {
      const result = await cli(root, argv);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).not.toBe("");
    }
  });

  test("a value that starts with a dash is a value, not an option", async () => {
    const root = makeVault({ "notes/alpha.md": ALPHA });
    const result = await cli(root, ["append", "alpha", "- a list item"]);
    expect(result.exitCode).toBe(0);
    expect(read(root, "notes/alpha.md")).toEndWith("Body.\n- a list item\n");
  });

  test("read prints the note's JSON shape; a missing note exits 1", async () => {
    const root = makeVault({ "notes/alpha.md": ALPHA });
    const result = await cli(root, ["read", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      name: "alpha",
      path: join(root, "notes/alpha.md"),
      properties: { created: "2026-07-01", status: "draft", authors: ["human"] },
      body: "# Alpha\n\nBody.\n",
    });
    const missing = await cli(root, ["read", "ghost"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("no note named 'ghost'");
  });

  test("daily verbs refuse a vault without the llmOS daily contract", async () => {
    const result = await cli(makeVault(), ["daily", "recent", "--vault", "second-vault"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("llmOS-profile feature");
  });
});

describe("headless writes", () => {
  test("set-property, remove-property, and append never call obsidian-cli", async () => {
    const root = makeVault({ "notes/alpha.md": ALPHA });
    const obsidian = recordedObsidian(root, true);
    const run = (argv: string[]) => cli(root, argv, { obsidian: obsidian.runner });

    expect((await run(["set-property", "alpha", "status", "active"])).stdout).toBe(
      "Set: status = active\n",
    );
    expect((await run(["set-property", "alpha", "authors", "claude"])).exitCode).toBe(0);
    expect((await run(["set-property", "alpha", "authors", "claude"])).exitCode).toBe(0);
    expect((await run(["remove-property", "alpha", "status"])).stdout).toBe("Removed: status\n");
    expect((await run(["remove-property", "alpha", "status"])).stdout).toBe("Not set: status\n");
    expect((await run(["append", "notes/alpha.md", "One more thought."])).stdout).toBe(
      "Appended to: notes/alpha.md\n",
    );

    expect(obsidian.calls).toEqual([]);
    expect(read(root, "notes/alpha.md")).toBe(
      "---\nauthors:\n  - human\n  - claude\ncreated: 2026-07-01\n---\n\n# Alpha\n\nBody.\nOne more thought.\n",
    );
  });

  test("set-property adds a link to a link property's list", async () => {
    const root = makeVault({ "notes/alpha.md": ALPHA });
    for (const link of [
      "[[projects/one/one|One]]",
      "[[projects/one/one|One]]",
      "[[projects/two/two|Two]]",
    ]) {
      expect((await cli(root, ["set-property", "alpha", "project", link])).exitCode).toBe(0);
    }
    expect(read(root, "notes/alpha.md")).toContain(
      'project:\n  - "[[projects/one/one|One]]"\n  - "[[projects/two/two|Two]]"\n',
    );
  });

  test("created is immutable and an unreadable block is never rewritten", async () => {
    const broken = "---\ntitle: [unclosed\n---\n\nBody.\n";
    const root = makeVault({ "notes/alpha.md": ALPHA, "notes/broken.md": broken });
    for (const argv of [
      ["set-property", "alpha", "created", "2020-01-01"],
      ["remove-property", "alpha", "created"],
      ["set-property", "broken", "status", "active"],
      ["append", "broken", "text"],
    ]) {
      const result = await cli(root, argv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain("    at ");
    }
    expect(read(root, "notes/alpha.md")).toBe(ALPHA);
    expect(read(root, "notes/broken.md")).toBe(broken);
  });

  test("a write keeps a symbolic link and the file's permission bits", async () => {
    const root = makeVault({ "notes/alpha.md": ALPHA });
    symlinkSync(join(root, "notes/alpha.md"), join(root, "notes/link.md"));
    chmodSync(join(root, "notes/alpha.md"), 0o600);
    expect((await cli(root, ["set-property", "notes/link.md", "status", "done"])).exitCode).toBe(0);
    expect(lstatSync(join(root, "notes/link.md")).isSymbolicLink()).toBe(true);
    expect(statSync(join(root, "notes/alpha.md")).mode & 0o777).toBe(0o600);
    expect(read(root, "notes/alpha.md")).toContain("status: done");
  });

  test("set-property gives a note without frontmatter a block; append does not", async () => {
    const root = makeVault({ "notes/plain.md": "# Plain\n", "notes/other.md": "# Other\n" });
    await cli(root, ["set-property", "plain", "status", "draft"]);
    await cli(root, ["append", "other", "More."]);
    expect(read(root, "notes/plain.md")).toBe("---\nstatus: draft\n---\n\n# Plain\n");
    expect(read(root, "notes/other.md")).toBe("# Other\nMore.\n");
  });

  test("daily append-thought writes under ## Thoughts of a note whose marker carries a hash", async () => {
    const marker = "<!-- llmos-activity:start hash=0f1e2d3c4b5a69788796a5b4c3d2e1f0 -->";
    const root = makeVault({ [DAILY]: dailyNote(TODAY, marker) });
    const obsidian = recordedObsidian(root, true);
    const before = read(root, DAILY);
    const result = await cli(root, ["daily", "append-thought", "A new thought."], {
      obsidian: obsidian.runner,
    });
    expect(result).toEqual({ exitCode: 0, stdout: `Appended to: ${DAILY}\n`, stderr: "" });
    expect(obsidian.calls).toEqual([]);
    const after = read(root, DAILY);
    expect(after).toContain("## Thoughts\n\nEarlier thought.\n\nA new thought.\n\n## Projects");
    // Everything from the marker on is kept byte for byte, including the
    // hard line break (two trailing spaces) in the machine-owned block.
    expect(after.slice(after.indexOf(marker))).toBe(before.slice(before.indexOf(marker)));
  });

  test("daily append-thought refuses marker syntax before creating anything", async () => {
    const root = makeVault();
    const obsidian = recordedObsidian(root);
    const result = await cli(root, ["daily", "append-thought", "<!-- llmos-activity:end -->"], {
      obsidian: obsidian.runner,
    });
    expect(result.exitCode).toBe(1);
    expect(obsidian.calls).toEqual([]);
    expect(existsSync(join(root, DAILY))).toBe(false);
  });

  test("a missing daily note is created from the template through Obsidian", async () => {
    const root = makeVault();
    const obsidian = recordedObsidian(root);
    const result = await cli(root, ["daily", "append-thought", "First."], {
      obsidian: obsidian.runner,
    });
    expect(result.exitCode).toBe(0);
    expect(obsidian.calls).toEqual([
      ["vault=llmOS", "create", `path=${DAILY}`, "template=daily-note"],
    ]);
    expect(read(root, DAILY)).toContain("## Thoughts\n\nFirst.\n\n## Projects");

    const closed = makeVault();
    const refused = await cli(closed, ["daily", "get-or-create"], {
      obsidian: recordedObsidian(closed, true).runner,
    });
    expect(refused.exitCode).toBe(3);
  });

  test("create writes a new note headlessly and refuses to overwrite or leave the vault", async () => {
    const root = makeVault();
    const obsidian = recordedObsidian(root, true);
    const run = (argv: string[]) => cli(root, argv, { obsidian: obsidian.runner });
    expect((await run(["create", "notes/new", "--content", "# New"])).stdout).toBe(
      "Created: notes/new.md\n",
    );
    expect(read(root, "notes/new.md")).toBe("# New\n");
    expect((await run(["create", "notes/new.md", "--content", "x"])).exitCode).toBe(1);
    expect((await run(["create", "../outside"])).exitCode).toBe(1);
    expect(obsidian.calls).toEqual([]);
    expect(read(root, "notes/new.md")).toBe("# New\n");
    // A template needs the app.
    expect((await run(["create", "notes/t", "--template", "project"])).exitCode).toBe(3);
  });

  test("move goes through obsidian-cli and exits 3 when Obsidian is not running", async () => {
    const root = makeVault({ "notes/alpha.md": ALPHA });
    const closed = recordedObsidian(root, true);
    const refused = await cli(root, ["move", "alpha", "archive/alpha.md"], {
      obsidian: closed.runner,
    });
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr).toContain("unable to find Obsidian");
    expect(read(root, "notes/alpha.md")).toBe(ALPHA);

    const open = recordedObsidian(root);
    const moved = await cli(root, ["move", "alpha", "archive/alpha.md"], { obsidian: open.runner });
    expect(moved).toEqual({
      exitCode: 0,
      stdout: "Moved: notes/alpha.md -> archive/alpha.md\n",
      stderr: "",
    });
    expect(open.calls).toEqual([
      ["vault=llmOS", "move", "path=notes/alpha.md", "to=archive/alpha.md"],
    ]);
  });
});

describe("file-inbox", () => {
  const capture = "---\ncreated: 2026-07-16\n---\n\n# Capture\n";

  test("moves, stamps destination properties and authors, and records the filing", async () => {
    const root = makeVault({ "raw/capture-1.md": capture, [DAILY]: dailyNote(TODAY) });
    const obsidian = recordedObsidian(root);
    const env = { CLAUDECODE: "1" };
    const { isolatedEnv } = await import("./helpers.ts");
    const result = await cli(root, ["file-inbox", "capture-1", "knowledge/some-note"], {
      obsidian: obsidian.runner,
      env: isolatedEnv(env),
    });
    expect(result.stdout).toBe("Filed: capture-1 -> knowledge/some-note.md\n");
    expect(obsidian.calls.map((call) => call[1])).toEqual(["move"]);
    expect(read(root, "knowledge/some-note.md")).toBe(
      '---\nauthors:\n  - claude\ncategories:\n  - "[[Knowledge]]"\ncreated: 2026-07-16\n---\n\n# Capture\n',
    );
    expect(read(root, DAILY)).toContain(
      "Earlier thought.\n\nFiled `capture-1` from inbox -> `knowledge/some-note.md`.\n\n## Projects",
    );

    // A retry finds the note at its destination: no second move, no duplicates.
    const again = await cli(root, ["file-inbox", "capture-1", "knowledge/some-note"], {
      obsidian: recordedObsidian(root, true).runner,
      env: isolatedEnv(env),
    });
    expect(again.exitCode).toBe(0);
    expect(read(root, "knowledge/some-note.md")).toContain("authors:\n  - claude\ncategories");
  });

  test("keeps a note's own categories", async () => {
    const paper = '---\ncategories:\n  - "[[Papers]]"\ncreated: 2026-07-16\n---\n\n# Paper\n';
    const root = makeVault({ "raw/paper.md": paper, [DAILY]: dailyNote(TODAY) });
    const result = await cli(root, ["file-inbox", "paper", "knowledge/paper.md"], {
      obsidian: recordedObsidian(root).runner,
    });
    expect(result.exitCode).toBe(0);
    expect(read(root, "knowledge/paper.md")).toBe(paper);
  });

  test("stamps [[Sources]] only on a captured source's note in raw/", async () => {
    const root = makeVault({
      "notes/drop.md": capture,
      "notes/source.md": capture,
      [DAILY]: dailyNote(TODAY),
    });
    for (const [note, destination] of [
      ["notes/drop.md", "raw/batch/drop.md"],
      ["notes/source.md", "raw/arxiv-1/source.md"],
    ] as const) {
      const result = await cli(root, ["file-inbox", note, destination], {
        obsidian: recordedObsidian(root).runner,
      });
      expect(result.exitCode).toBe(0);
    }
    expect(read(root, "raw/batch/drop.md")).not.toContain("categories");
    expect(read(root, "raw/arxiv-1/source.md")).toContain('categories:\n  - "[[Sources]]"');
  });

  test("refuses an unknown area or an unreadable block before any move", async () => {
    const root = makeVault({
      "raw/capture-1.md": capture,
      "raw/broken.md": "---\ntitle: [unclosed\n---\n\nx\n",
    });
    const obsidian = recordedObsidian(root);
    for (const argv of [
      ["file-inbox", "capture-1", "categories/templates/x.md"],
      ["file-inbox", "broken", "knowledge/broken.md"],
    ]) {
      expect((await cli(root, argv, { obsidian: obsidian.runner })).exitCode).toBe(1);
    }
    expect(obsidian.calls).toEqual([]);
    expect(existsSync(join(root, "raw/capture-1.md"))).toBe(true);
  });

  test("exits 3 and leaves the note in place when Obsidian is not running", async () => {
    const root = makeVault({ "raw/capture-1.md": capture });
    const result = await cli(root, ["file-inbox", "capture-1", "knowledge/x.md"], {
      obsidian: recordedObsidian(root, true).runner,
    });
    expect(result.exitCode).toBe(3);
    expect(read(root, "raw/capture-1.md")).toBe(capture);
  });
});
