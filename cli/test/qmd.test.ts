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
import { documentVectors, openQmd, qmdLocation, search } from "../src/qmd.ts";
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
    expect(report.memory).toBeNull();
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

describe("documentVectors", () => {
  test("gives each active document the normalized mean of its chunk vectors", async () => {
    const { env } = await indexedVault();
    const store = await openQmd(qmdLocation(env), false);
    try {
      store.internal.ensureVecTable(3);
      const hashes = Object.fromEntries(
        (
          store.internal.db.prepare("SELECT path, hash FROM documents").all() as {
            path: string;
            hash: string;
          }[]
        ).map(({ path, hash }) => [path, hash]),
      );
      const insert = (path: string, seq: number, vector: number[]) =>
        store.internal.insertEmbedding(
          hashes[path] as string,
          seq,
          0,
          new Float32Array(vector),
          "test-model",
          "2026-10-07",
        );
      // Two chunks whose mean (1.5, 2, 0) has length 2.5.
      insert("notes/alpha.md", 0, [3, 0, 0]);
      insert("notes/alpha.md", 1, [0, 4, 0]);
      insert("notes/beta.md", 0, [0, 0, 1]);
      store.internal.db
        .prepare("UPDATE documents SET active = 0 WHERE path = ?")
        .run("notes/beta.md");

      const vectors = await documentVectors(store, "llmos");

      expect([...(vectors?.keys() ?? [])]).toEqual(["notes/alpha.md"]);
      const alpha = Array.from(vectors?.get("notes/alpha.md") ?? []);
      expect(alpha).toHaveLength(3);
      for (const [got, want] of alpha.map((x, i) => [x, [0.6, 0.8, 0][i] as number] as const)) {
        expect(got).toBeCloseTo(want, 5);
      }
      expect(await documentVectors(store, "other")).toBeNull();
    } finally {
      await store.close();
    }
  });
});

describe("discover similarity", () => {
  test("a trio that shares one key forms a cluster through the stored vectors, with no model", async () => {
    const { root, env } = await indexedVault();
    const shared = "10.1234/abc";
    writeFiles(root, {
      "projects/x/notes.md": `# X\n\n${shared} and 10.4321/only-x\n`,
      "projects/y/notes.md": `# Y\n\n${shared}\n`,
      "projects/z/notes.md": `# Z\n\n${shared}\n`,
    });
    await cli(root, ["reindex", "--no-embed"], { env });
    const out = join(root, "..", "reports");
    const run = async () =>
      JSON.parse((await cli(root, ["discover", "--out", out, "--no-record"], { env })).stdout);

    // The index holds no vectors yet: a notice, and one shared key is too little.
    const without = await run();
    expect(without.qmd_notice).toContain("qmd similarity skipped");
    expect(without.clusters).toEqual([]);

    const store = await openQmd(qmdLocation(env), false);
    try {
      store.internal.ensureVecTable(3);
      const docs = store.internal.db
        .prepare("SELECT path, hash FROM documents WHERE active = 1")
        .all() as { path: string; hash: string }[];
      const direction: Record<string, number[]> = {
        "projects/x/notes.md": [1, 0, 0],
        "projects/y/notes.md": [0.9, 0.1, 0],
        "projects/z/notes.md": [0.8, 0.2, 0],
      };
      for (const { path, hash } of docs) {
        const vector = direction[path] ?? [0, 0, 1];
        store.internal.insertEmbedding(
          hash,
          0,
          0,
          new Float32Array(vector),
          "test-model",
          "2026-10-07",
        );
      }
    } finally {
      await store.close();
    }

    const withVectors = await run();
    expect(withVectors.qmd_notice).toBeNull();
    expect(withVectors.clusters).toHaveLength(1);
    expect(withVectors.clusters[0].notes).toEqual([
      "projects/x/notes.md",
      "projects/y/notes.md",
      "projects/z/notes.md",
    ]);
    expect(withVectors.clusters[0].signals.similar_pairs).toBe(3);
  });
});
