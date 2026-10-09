import { describe, expect, test } from "bun:test";
import { cli, makeVault } from "./helpers.ts";

interface Found {
  code: string;
  line: number;
  message: string;
}

async function check(text: string, path = "notes/n.md") {
  const root = makeVault({ [path]: text });
  const result = await cli(root, ["check", path]);
  const findings = (JSON.parse(result.stdout) as { findings: Found[] }).findings;
  return { exitCode: result.exitCode, findings };
}

/** The `[code, line]` pairs `check` reports for a note with this text. */
async function found(text: string, path?: string): Promise<[string, number][]> {
  return (await check(text, path)).findings.map((f) => [f.code, f.line]);
}

const TABLE = "| a | b |\n|---|---|\n";

describe("check Markdown correctness", () => {
  test("a table row with the wrong number of cells is reported", async () => {
    expect(await found(`# T\n\n${TABLE}| 1 | 2 | 3 |\n`)).toEqual([["table-column-count", 5]]);
  });

  test("an empty link destination is reported", async () => {
    expect(await found("# T\n\nSee [the paper]() now.\n")).toEqual([["empty-link", 3]]);
  });

  test("a reversed link is reported", async () => {
    expect(await found("# T\n\nSee (the paper)[https://example.com] now.\n")).toEqual([
      ["reversed-link", 3],
    ]);
  });

  test("an unescaped alias pipe in a table wikilink is reported once per line, with the fix", async () => {
    const { findings, exitCode } = await check(
      `# T\n\n${TABLE}| [[x|label]] | 2 |\n| ![[i.png|100]] | 2 |\n`,
    );
    expect(findings.map((f) => [f.code, f.line])).toEqual([
      ["table-wikilink-pipe", 5],
      ["table-wikilink-pipe", 6],
    ]);
    expect(findings[0]?.message).toContain("\\|");
    expect(exitCode).toBe(1);
  });

  test("escaped pipes, code, and pipes outside tables pass", async () => {
    const text =
      "# T\n\n| a | b | c |\n|---|---|---|\n" +
      "| [[x\\|label]] | `[[y|z]]` |\n\n" +
      "Prose [[x|label]] is fine.\n\n```\n| [[x|label]] |\n```\n";
    expect(await found(text)).toEqual([]);
  });

  test("line numbers count the frontmatter lines", async () => {
    const text = "---\nstatus: active\ntopics:\n  - a\n---\n\n[x]()\n";
    expect(await found(text)).toEqual([["empty-link", 7]]);
  });

  test("notes under sources/ get no Markdown findings, and a dot-folder file is no vault note", async () => {
    expect(await found("[x]()\n", "sources/s/source.md")).toEqual([]);
    const dot = await cli(makeVault({ ".agents/n.md": "[x]()\n" }), ["check", ".agents/n.md"]);
    expect(dot.exitCode).not.toBe(0);
    expect(await found("[x]()\n", "projects/sources/n.md")).toEqual([["empty-link", 1]]);
  });
});
