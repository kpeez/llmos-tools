import { describe, expect, test } from "bun:test";
import { type FmtReport, loadLinter } from "../src/fmt.ts";
import { cli, makeVault, read } from "./helpers.ts";

const MESSY = "# Title\n\nline with trailing spaces   \n\n\n\nsecond paragraph\n";

/** A saved Linter settings file: every rule's options, as the plugin writes them, with two rules on. */
async function savedSettings(): Promise<unknown> {
  const { defaults, ruleDefaults: rules } = await loadLinter();
  return {
    ...defaults,
    ruleConfigs: {
      ...rules,
      "trailing-spaces": { ...rules["trailing-spaces"], enabled: true },
      "consecutive-blank-lines": { ...rules["consecutive-blank-lines"], enabled: true },
    },
    foldersToIgnore: ["drafts"],
  };
}
const CLEAN = "# Title\n\nline with trailing spaces\n\nsecond paragraph\n";

async function vault(): Promise<string> {
  return makeVault({
    ".obsidian/plugins/obsidian-linter/data.json": JSON.stringify(await savedSettings()),
    "notes/messy.md": MESSY,
    "notes/clean.md": CLEAN,
    "raw/source.md": MESSY,
    "drafts/wip.md": MESSY,
  });
}

async function fmt(root: string, ...args: string[]) {
  const result = await cli(root, ["fmt", ...args]);
  return { ...result, report: JSON.parse(result.stdout) as FmtReport };
}

describe("fmt", () => {
  test("rewrites a note the Linter changes and leaves a clean note, captured sources, and ignored folders alone", async () => {
    const root = await vault();
    const { exitCode, report } = await fmt(root);
    expect(exitCode).toBe(0);
    expect(report.changed).toEqual(["notes/messy.md"]);
    expect(report.skipped).toBe(2);
    expect(read(root, "notes/messy.md")).toBe(CLEAN);
    expect(read(root, "raw/source.md")).toBe(MESSY);
    expect(read(root, "drafts/wip.md")).toBe(MESSY);
    // A second run finds nothing to change.
    expect((await fmt(root)).report.changed).toEqual([]);
  });

  test("--check lists the notes that would change, writes nothing, and exits 1", async () => {
    const root = await vault();
    const { exitCode, report } = await fmt(root, "--check");
    expect(exitCode).toBe(1);
    expect(report.changed).toEqual(["notes/messy.md"]);
    expect(read(root, "notes/messy.md")).toBe(MESSY);
    const clean = await fmt(root, "notes/clean", "--check");
    expect(clean.exitCode).toBe(0);
    expect(clean.report.changed).toEqual([]);
  });

  test("a path limits the run to a note or a folder, and raw/ stays frozen even when named", async () => {
    const root = await vault();
    expect((await fmt(root, "raw", "--check")).report.skipped).toBe(1);
    expect((await fmt(root, "raw/source.md")).report.changed).toEqual([]);
    expect(read(root, "raw/source.md")).toBe(MESSY);
    expect((await fmt(root, "notes")).report.changed).toEqual(["notes/messy.md"]);
  });

  test("a vault without Linter settings fails and writes nothing", async () => {
    const root = makeVault({ "notes/messy.md": MESSY });
    const result = await cli(root, ["fmt"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no Obsidian Linter settings");
    expect(read(root, "notes/messy.md")).toBe(MESSY);
  });

  test("a settings file that lacks a rule's options fails instead of using invented defaults", async () => {
    const root = makeVault({
      ".obsidian/plugins/obsidian-linter/data.json": JSON.stringify({ ruleConfigs: {} }),
      "notes/messy.md": MESSY,
    });
    const result = await cli(root, ["fmt"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has no options for");
    expect(read(root, "notes/messy.md")).toBe(MESSY);
  });
});
