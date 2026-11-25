import { describe, expect, test } from "bun:test";
import { type FmtReport, loadLinter, settle } from "../src/fmt.ts";
import { cli, makeVault, read } from "./helpers.ts";

const MESSY = "# Title\n\nline with trailing spaces   \n\n\n\nsecond paragraph\n";

/** A saved Linter settings file: every rule's options, as the plugin writes them, with the rules in `on` enabled. */
async function savedSettings(
  on = ["trailing-spaces", "consecutive-blank-lines"],
): Promise<unknown> {
  const { defaults, ruleDefaults: rules } = await loadLinter();
  return {
    ...defaults,
    ruleConfigs: Object.fromEntries(
      Object.entries(rules).map(([alias, options]) => [
        alias,
        on.includes(alias) ? { ...options, enabled: true } : options,
      ]),
    ),
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

  test("one run leaves --check clean when one pass of the rules is not enough", async () => {
    // The two math-block rules, run together, break this list item over two passes.
    const text = "1. x\n   $$\n   a\n   $$\n   y\n";
    const on = ["empty-line-around-math-blocks", "move-math-block-indicators-to-their-own-line"];
    const settings = await savedSettings(on);
    const { lint } = await loadLinter();
    const once = lint(text, settings as Record<string, unknown>);
    expect(lint(once, settings as Record<string, unknown>)).not.toBe(once);
    const root = makeVault({
      ".obsidian/plugins/obsidian-linter/data.json": JSON.stringify(settings),
      "notes/math.md": text,
    });
    expect((await fmt(root)).report.changed).toEqual(["notes/math.md"]);
    const after = await fmt(root, "--check");
    expect(after.exitCode).toBe(0);
    expect(after.report.changed).toEqual([]);
  });

  test("a note that never settles is refused after five passes", () => {
    let passes = 0;
    expect(() => settle("a", (text) => `${text}${++passes}`)).toThrow(
      "did not settle after 5 passes",
    );
    expect(passes).toBe(5);
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
