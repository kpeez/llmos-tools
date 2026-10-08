/**
 * qmd through the SDK, on a temporary index and config (never the real
 * `~/.cache/qmd`): keyword search, and the health report's index gaps.
 * Keyword search and `update` need no model, so nothing is downloaded.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QMDStore } from "@tobilu/qmd";
import { searchMode } from "../src/commands.ts";
import { openQmd, qmdLocation, search } from "../src/qmd.ts";
import { cli, isolatedEnv, makeVault, writeFiles } from "./helpers.ts";

const NOTES = {
  "notes/alpha.md": "---\nstatus: active\n---\n\n# Alpha\n\nThe zebrafish tank needs a heater.\n",
  "notes/beta.md": "---\nstatus: active\n---\n\n# Beta\n\nLinks to [[alpha]].\n",
};

/** A vault and an isolated environment whose qmd index holds the vault as `llmos`. */
async function indexedVault(): Promise<{ root: string; env: Record<string, string> }> {
  const root = makeVault(NOTES);
  const env = isolatedEnv();
  const config = join(env.QMD_CONFIG_DIR as string, "index.yml");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, `collections:\n  llmos:\n    path: ${root}\n    pattern: "**/*.md"\n`);
  mkdirSync(dirname(env.INDEX_PATH as string), { recursive: true });
  const store = await openQmd(qmdLocation(env), true);
  try {
    await store.update({ collections: ["llmos"] });
  } finally {
    await store.close();
  }
  return { root, env };
}

describe("qmd", () => {
  test("search returns keyword hits from the collection", async () => {
    const { root, env } = await indexedVault();
    const result = await cli(root, ["search", "zebrafish"], { env });
    expect(result.exitCode).toBe(0);
    const hits = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(hits.map((hit) => hit.path)).toEqual(["notes/alpha.md"]);
    expect(Object.keys(hits[0] as object).sort()).toEqual([
      "line",
      "path",
      "score",
      "snippet",
      "title",
    ]);
    expect(hits[0]?.title).toBe("Alpha");

    const missing = await cli(root, ["search", "zebrafish", "--collection", "nope"], { env });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("qmd collection 'nope' not found");
  });

  test("health reports notes the index does not hold", async () => {
    const { root, env } = await indexedVault();
    writeFiles(root, { "notes/gamma.md": "# Gamma\n" });
    const result = await cli(root, ["health", "--json"], { env });
    const report = JSON.parse(result.stdout) as { qmd_gaps: string[]; qmd_notice: unknown };
    expect(report.qmd_gaps).toEqual(["notes/gamma.md"]);
    expect(report.qmd_notice).toBeNull();
    expect(result.exitCode).toBe(1);
  });

  test("reindex --no-embed scans the files only, and health counts what needs embedding", async () => {
    const { root, env } = await indexedVault();
    writeFiles(root, { "notes/gamma.md": "# Gamma\n\nNew note.\n" });

    const result = await cli(root, ["reindex", "--no-embed"], { env });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.update).toMatchObject({ indexed: 1 });
    expect(report.embed).toBeNull();
    expect(report.cleanup).toBeNull();
    const health = await cli(root, ["health", "--json"], { env });
    const section = JSON.parse(health.stdout) as { qmd_gaps: string[]; qmd_unembedded: number };
    expect(section.qmd_gaps).toEqual([]);
    // Nothing was ever embedded: every note in the vault needs it.
    const notes = [...new Bun.Glob("**/*.md").scanSync({ cwd: root })];
    expect(notes).toContain("notes/gamma.md");
    expect(section.qmd_unembedded).toBe(notes.length);
  });

  test("without an index, health gives a notice and creates no index", async () => {
    const root = makeVault(NOTES);
    const env = isolatedEnv();
    const result = await cli(root, ["health", "--json", "--qmd-collection", "llmos"], { env });
    const report = JSON.parse(result.stdout) as { qmd_gaps: string[]; qmd_notice: string };
    expect(report.qmd_gaps).toEqual([]);
    expect(report.qmd_notice).toBe(
      "qmd unavailable or collection 'llmos' not found; qmd-gap section skipped",
    );
    expect(existsSync(env.INDEX_PATH as string)).toBe(false);
  });
});

describe("search modes", () => {
  /** A store stand-in that records which search ran; the real ones need models. */
  function recordingStore(calls: string[]): QMDStore {
    const doc = { title: "Alpha", body: "# Alpha\n\nThe zebrafish tank.\n", score: 0.5 };
    return {
      listCollections: async () => [{ name: "llmos" }],
      searchLex: async () => {
        calls.push("lex");
        return [{ ...doc, filepath: "qmd://llmos/notes/alpha.md" }];
      },
      searchVector: async (_query: string, options: object) => {
        calls.push(`vector ${JSON.stringify(options)}`);
        return [{ ...doc, filepath: "qmd://llmos/notes/alpha.md", chunkPos: 0 }];
      },
      search: async (options: object) => {
        calls.push(`hybrid ${JSON.stringify(options)}`);
        return [{ ...doc, file: "qmd://llmos/notes/alpha.md", bestChunkPos: 0 }];
      },
    } as unknown as QMDStore;
  }

  test("keyword, semantic (vector only), and hybrid each run their own qmd search", async () => {
    for (const [mode, expected] of [
      ["keyword", "lex"],
      ["semantic", 'vector {"collection":"llmos","limit":3}'],
      ["hybrid", 'hybrid {"query":"zebrafish","collection":"llmos","limit":3}'],
    ] as const) {
      const calls: string[] = [];
      const hits = await search(recordingStore(calls), "zebrafish", {
        collection: "llmos",
        limit: 3,
        mode,
      });
      expect(calls).toEqual([expected]);
      expect(hits[0]).toMatchObject({ path: "notes/alpha.md", title: "Alpha", score: 0.5 });
    }
  });

  test("--hybrid wins over --semantic, which wins over keyword", () => {
    expect(searchMode({})).toBe("keyword");
    expect(searchMode({ semantic: true })).toBe("semantic");
    expect(searchMode({ hybrid: true })).toBe("hybrid");
    expect(searchMode({ semantic: true, hybrid: true })).toBe("hybrid");
  });
});
