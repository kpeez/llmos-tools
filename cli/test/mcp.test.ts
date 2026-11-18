/**
 * The llmOS MCP server over its real protocol (in process, on stream
 * pairs): the tool list, each tool against a temporary vault, the stamps
 * the write tools add, the warm vault model, and the refusal of every
 * hostile argument. Never the real vault or the real qmd index.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "../src/cli.ts";
import { COMMANDS } from "../src/commands.ts";
import { Frontmatter } from "../src/frontmatter.ts";
import { INSTRUCTIONS } from "../src/mcp.ts";
import { READ_TOOLS, WRITE_TOOLS } from "../src/mcp-names.ts";
import type { ObsidianRunner } from "../src/obsidian.ts";
import { openQmd, qmdLocation } from "../src/qmd.ts";
import { VaultModel } from "../src/vault.ts";
import {
  dailyNote,
  isolatedEnv,
  makeVault,
  noConverter,
  offline,
  read,
  recordedObsidian,
  scratch,
  TODAY,
  writeFiles,
} from "./helpers.ts";
import { connect } from "./mcp-client.ts";

const NOTE = "---\nstatus: draft\ntopics:\n  - garden\n---\n\n# Alpha\n\nSee [[beta]].\n";
const BETA = "---\nstatus: draft\ntopics:\n  - garden\n---\n\n# Beta\n\nThe zebrafish tank.\n";
const CAPTURE = "---\nstatus: draft\n---\n\n# Capture\n\nA loose idea.\n";
const SECRET = "---\nstatus: draft\n---\n\n# Secret\n\nTOPSECRET\n";
const DAILY = `daily/${TODAY}.md`;

function vault(files: Record<string, string> = {}): string {
  return makeVault({
    "notes/alpha.md": NOTE,
    "notes/beta.md": BETA,
    "raw/capture.md": CAPTURE,
    ...files,
  });
}

function contextFor(
  root: string,
  options: { env?: Record<string, string>; obsidian?: ObsidianRunner } = {},
): Context {
  return {
    env: options.env ?? isolatedEnv(),
    root: () => root,
    model: (path) => VaultModel.load(path),
    today: () => TODAY,
    obsidian: options.obsidian ?? recordedObsidian(root).runner,
    fetch: offline,
    convertPdf: noConverter,
  };
}

function properties(root: string, path: string): Record<string, unknown> {
  return Frontmatter.parse(read(root, path)).properties;
}

describe("the tool list", () => {
  test("lists the read and write tools with their registry help and hints", async () => {
    const { client, close } = await connect(contextFor(vault()));
    const tools = await client.tools();
    await close();
    expect(tools.map((tool) => tool.name)).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
    const commandOf: Record<string, string> = {
      daily_append_thought: "daily append-thought",
      file_inbox: "file-inbox",
      set_property: "set-property",
    };
    for (const tool of tools) {
      const name = tool.name as string;
      const command = COMMANDS.find((entry) => entry.name === (commandOf[name] ?? name));
      expect(tool.description as string).toStartWith(
        `${command?.summary}\n\n${command?.description}`,
      );
      const hints = tool.annotations as Record<string, boolean>;
      expect(hints.readOnlyHint).toBe((READ_TOOLS as readonly string[]).includes(name));
      expect(hints.openWorldHint).toBe(false);
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(
        false,
      );
    }
  });

  test("the server instructions fit Claude Code's 2,048-character limit", () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
  });
});

describe("read tools", () => {
  test("read, neighbors, subgraph, check, and health answer from the vault", async () => {
    const root = vault();
    const { client, close } = await connect(contextFor(root));
    const note = JSON.parse((await client.call("read", { note: "alpha" })).text);
    expect(note.properties.status).toBe("draft");
    expect(note.body).toContain("# Alpha");
    const neighbors = JSON.parse((await client.call("neighbors", { note: "alpha" })).text);
    expect(neighbors).toMatchObject({ note: "alpha", outgoing: ["beta"], backlinks: [] });
    const subgraph = JSON.parse((await client.call("subgraph", { note: "alpha", depth: 2 })).text);
    expect(subgraph.nodes).toEqual(["alpha", "beta"]);
    const check = await client.call("check", { note: "notes/alpha.md" });
    expect(check.isError).toBe(false);
    expect(JSON.parse(check.text).findings).toEqual([]);
    const health = await client.call("health", {});
    expect(health.isError).toBe(false);
    expect(JSON.parse(health.text)).toHaveProperty("orphans");
    await close();
  });

  test("read narrows to one section or the properties, and list reads a folder", async () => {
    const root = vault({
      "notes/gamma.md":
        "---\nstatus: done\n---\n\n# Gamma\n\n## Results\n\nIt grew.\n\n### Detail\n\nTall.\n\n## Next\n\nPrune.\n",
    });
    const { client, close } = await connect(contextFor(root));
    const section = JSON.parse(
      (await client.call("read", { note: "gamma", section: "Results" })).text,
    );
    expect(section).toMatchObject({ section: "Results", properties: { status: "done" } });
    expect(section.body).toBe("\nIt grew.\n\n### Detail\n\nTall.\n");
    const missing = await client.call("read", { note: "gamma", section: "Methods" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("# Gamma | ## Results | ### Detail | ## Next");
    const head = JSON.parse(
      (await client.call("read", { note: "gamma", properties_only: true })).text,
    );
    expect(head).not.toHaveProperty("body");
    expect(head.properties.status).toBe("done");
    const listed = JSON.parse((await client.call("list", { folder: "notes/" })).text);
    expect(listed.map((note: { name: string }) => note.name).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(listed.every((note: object) => !("body" in note))).toBe(true);
    const bodies = JSON.parse(
      (await client.call("list", { folder: "raw", properties_only: false })).text,
    );
    expect(bodies).toEqual([
      expect.objectContaining({ name: "capture", body: expect.stringContaining("A loose idea.") }),
    ]);
    await close();
  });

  test("an edit made outside the server is visible to the next read", async () => {
    const root = vault();
    const { client, close } = await connect(contextFor(root));
    expect((await client.call("read", { note: "alpha" })).text).toContain("See [[beta]].");
    writeFileSync(join(root, "notes/alpha.md"), NOTE.replace("See [[beta]].", "Edited outside."));
    writeFiles(root, { "notes/gamma.md": "# Gamma\n" });
    expect((await client.call("read", { note: "alpha" })).text).toContain("Edited outside.");
    expect((await client.call("read", { note: "gamma" })).isError).toBe(false);
    await close();
  });

  test("search runs keyword search on the llmos collection of the qmd index", async () => {
    const root = vault();
    const env = isolatedEnv();
    const config = join(env.QMD_CONFIG_DIR as string, "index.yml");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, `collections:\n  llmos:\n    path: ${root}\n    pattern: "**/*.md"\n`);
    mkdirSync(dirname(env.INDEX_PATH as string), { recursive: true });
    const store = await openQmd(qmdLocation(env), true);
    await store.update({ collections: ["llmos"] });
    await store.close();

    const { client, close } = await connect(contextFor(root, { env }));
    for (let i = 0; i < 2; i++) {
      const hits = JSON.parse((await client.call("search", { query: "zebrafish" })).text);
      expect(hits.map((hit: { path: string }) => hit.path)).toEqual(["notes/beta.md"]);
    }
    await close();
  });

  test("search without a qmd index is a tool error, and no index is created", async () => {
    const env = isolatedEnv();
    const { client, close } = await connect(contextFor(vault(), { env }));
    const result = await client.call("search", { query: "zebrafish" });
    await close();
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no qmd index");
    expect(existsSync(env.INDEX_PATH as string)).toBe(false);
  });
});

describe("write tools stamp updated", () => {
  test("daily_append_thought creates today's note when missing and stamps it", async () => {
    const root = vault();
    const obsidian = recordedObsidian(root);
    const { client, close } = await connect(contextFor(root, { obsidian: obsidian.runner }));
    const result = await client.call("daily_append_thought", {
      text: 'A lesson with `code`, "quotes", and $dollars.\nSecond line.',
    });
    await close();
    expect(result).toEqual({ isError: false, text: `Appended to: ${DAILY}` });
    expect(read(root, DAILY)).toContain(
      '## Thoughts\n\nA lesson with `code`, "quotes", and $dollars.\nSecond line.\n',
    );
    expect(properties(root, DAILY)).toMatchObject({ updated: TODAY });
    expect(obsidian.calls).toHaveLength(1);
  });

  test("set_property stamps the note", async () => {
    const root = vault();
    const { client, close } = await connect(contextFor(root), "claude-code");
    const result = await client.call("set_property", {
      note: "alpha",
      key: "status",
      value: "active",
    });
    await close();
    expect(result).toEqual({ isError: false, text: "Set: status = active" });
    expect(properties(root, "notes/alpha.md")).toMatchObject({
      status: "active",
      updated: TODAY,
    });
  });

  test("set_property refuses the run record of discover, and health reports its date", async () => {
    const record = "categories/Knowledge.md";
    const root = vault({ [record]: "---\ndiscovered: 2026-09-01\n---\n\n# Knowledge\n" });
    const { client, close } = await connect(contextFor(root), "claude-code");
    const refused = await client.call("set_property", {
      note: record,
      key: "discovered",
      value: TODAY,
    });
    const other = await client.call("set_property", { note: record, key: "status", value: "x" });
    const health = JSON.parse((await client.call("health", {})).text);
    await close();
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("only `llmos-vault discover` sets it");
    expect(other.isError).toBe(false);
    expect(properties(root, record).discovered).toBe("2026-09-01");
    expect(health.overdue_jobs).toContainEqual({
      job: "discover",
      last_success: "2026-09-01",
      max_age_days: 10,
    });
  });

  test("file_inbox files the note and stamps it and today's note", async () => {
    const root = vault({ [DAILY]: dailyNote(TODAY) });
    const obsidian = recordedObsidian(root);
    const { client, close } = await connect(contextFor(root, { obsidian: obsidian.runner }));
    const result = await client.call("file_inbox", {
      note: "capture",
      destination: "knowledge/capture",
    });
    await close();
    expect(result).toEqual({
      isError: false,
      text: "Filed: capture -> knowledge/capture.md",
    });
    expect(existsSync(join(root, "raw/capture.md"))).toBe(false);
    expect(properties(root, "knowledge/capture.md")).toMatchObject({
      categories: ["[[Knowledge]]"],
      updated: TODAY,
    });
    expect(properties(root, DAILY)).toMatchObject({ updated: TODAY });
    expect(read(root, DAILY)).toContain("Filed `capture` from inbox -> `knowledge/capture.md`.");
  });

  test("file_inbox reports a closed Obsidian app as a tool error", async () => {
    const root = vault();
    const obsidian = recordedObsidian(root, true);
    const { client, close } = await connect(contextFor(root, { obsidian: obsidian.runner }));
    const result = await client.call("file_inbox", {
      note: "capture",
      destination: "knowledge/capture.md",
    });
    await close();
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Obsidian");
    expect(read(root, "raw/capture.md")).toBe(CAPTURE);
  });
});

describe("the warm vault model", () => {
  test("an image created or deleted between two health calls changes the health result", async () => {
    const root = vault({ "notes/pic.md": `${NOTE}\n![[plot.png]]\n` });
    const { client, close } = await connect(contextFor(root));
    const unresolved = async (): Promise<string[]> =>
      JSON.parse((await client.call("health", {})).text).unresolved_links.map(
        (link: { target: string }) => link.target,
      );
    expect(await unresolved()).toContain("plot.png");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets/plot.png"), "x");
    expect(await unresolved()).not.toContain("plot.png");
    unlinkSync(join(root, "assets/plot.png"));
    expect(await unresolved()).toContain("plot.png");
    await close();
  });
});

describe("hostile arguments are refused", () => {
  /**
   * In the vault, `link.md` links to a note outside it, and `linkdir/` and
   * `knowledge/linkdir/` link to the outside folder. `{away}` is that folder.
   */
  function hostileVault(): { root: string; away: string } {
    const away = scratch("away");
    writeFileSync(join(away, "secret.md"), SECRET);
    const root = vault({ "knowledge/existing.md": NOTE });
    symlinkSync(join(away, "secret.md"), join(root, "link.md"));
    symlinkSync(away, join(root, "linkdir"));
    symlinkSync(away, join(root, "knowledge", "linkdir"));
    return { root, away };
  }

  const NOTE_ESCAPES = ["{away}/secret.md", "link.md", "linkdir/secret.md"];
  const DESTINATION_ESCAPES = [
    "../escape.md",
    "knowledge/../../escape.md",
    "knowledge/linkdir/new.md",
    "{away}/new.md",
  ];
  const cases: [string, string, (path: string) => Record<string, unknown>][] = [];
  for (const path of NOTE_ESCAPES) {
    cases.push(
      ["read", path, (note) => ({ note })],
      ["neighbors", path, (note) => ({ note })],
      ["subgraph", path, (note) => ({ note, depth: 1 })],
      ["check", path, (note) => ({ note })],
      ["set_property", path, (note) => ({ note, key: "status", value: "x" })],
      ["file_inbox", path, (note) => ({ note, destination: "knowledge/filed.md" })],
    );
  }
  for (const path of DESTINATION_ESCAPES) {
    cases.push(["file_inbox", path, (destination) => ({ note: "capture", destination })]);
  }

  for (const [tool, path, args] of cases) {
    test(`${tool} refuses ${JSON.stringify(args(path))}`, async () => {
      const { root, away } = hostileVault();
      const obsidian = recordedObsidian(root);
      const { client, close } = await connect(contextFor(root, { obsidian: obsidian.runner }));
      const result = await client.call(tool, args(path.replace("{away}", away)));
      await close();
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("TOPSECRET");
      expect(obsidian.calls).toEqual([]);
      expect(readdirSync(away).sort()).toEqual(["secret.md"]);
      expect(readFileSync(join(away, "secret.md"), "utf8")).toBe(SECRET);
      expect(existsSync(join(root, "..", "escape.md"))).toBe(false);
      expect(read(root, "raw/capture.md")).toBe(CAPTURE);
    });
  }

  test("list leaves out notes linked out of the vault", async () => {
    const { root } = hostileVault();
    const { client, close } = await connect(contextFor(root));
    for (const folder of ["linkdir", "knowledge", "knowledge/linkdir"]) {
      const result = await client.call("list", { folder, properties_only: false });
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain("TOPSECRET");
    }
    await close();
  });

  test("daily_append_thought refuses a daily note linked out of the vault", async () => {
    const { root, away } = hostileVault();
    mkdirSync(join(root, "daily"), { recursive: true });
    writeFileSync(join(away, "daily.md"), dailyNote(TODAY));
    symlinkSync(join(away, "daily.md"), join(root, DAILY));
    const { client, close } = await connect(contextFor(root));
    const result = await client.call("daily_append_thought", { text: "Escape?" });
    await close();
    expect(result.isError).toBe(true);
    expect(readFileSync(join(away, "daily.md"), "utf8")).toBe(dailyNote(TODAY));
  });

  const SHAPES: [string, unknown][] = [
    ["read", {}],
    ["read", { note: 42 }],
    ["read", { note: "alpha", vault: "second-vault" }],
    ["read", { note: "al\npha" }],
    ["read", { note: "a".repeat(1025) }],
    ["read", null],
    ["read", { note: "alpha", properties_only: "yes" }],
    ["list", {}],
    ["list", { folder: "../notes" }],
    ["subgraph", { note: "alpha", depth: 11 }],
    ["subgraph", { note: "alpha", depth: 1.5 }],
    ["health", { "qmd-collection": "other" }],
    ["search", { query: "x", collection: "other" }],
    ["search", { query: "x", limit: 51 }],
    ["search", { query: "x\ny" }],
    ["daily_append_thought", { text: "" }],
    ["daily_append_thought", { text: "x".repeat(20_001) }],
    ["daily_append_thought", { text: "bell\u0007" }],
    ["daily_append_thought", { text: "<!-- llmos-activity:end -->" }],
    ["set_property", { note: "alpha", key: "status", value: "two\nlines" }],
    ["set_property", { note: "alpha", key: "created", value: "2020-01-01" }],
    ["set_property", { note: "alpha", key: "status" }],
    ["file_inbox", { note: "capture", destination: "elsewhere/capture.md" }],
    ["nonexistent_tool", {}],
  ];
  for (const [tool, args] of SHAPES) {
    test(`${tool} refuses ${JSON.stringify(args)?.slice(0, 80)}`, async () => {
      const root = vault({ [DAILY]: dailyNote(TODAY) });
      const obsidian = recordedObsidian(root);
      const { client, close } = await connect(contextFor(root, { obsidian: obsidian.runner }));
      const result = await client.call(tool, args);
      await close();
      expect(result.isError).toBe(true);
      expect(obsidian.calls).toEqual([]);
      expect(read(root, "notes/alpha.md")).toBe(NOTE);
      expect(read(root, DAILY)).toBe(dailyNote(TODAY));
      expect(read(root, "raw/capture.md")).toBe(CAPTURE);
    });
  }
});
