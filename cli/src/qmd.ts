/**
 * qmd search and indexing through its SDK (`@tobilu/qmd`, pinned exactly).
 *
 * The store is the one the `qmd` command uses: the index at
 * `$INDEX_PATH`, else `$XDG_CACHE_HOME/qmd/index.sqlite`, else
 * `~/.cache/qmd/index.sqlite`; and the collections from qmd's YAML config
 * (`$QMD_CONFIG_DIR`, else `$XDG_CONFIG_HOME/qmd`, else `~/.config/qmd`, file
 * `index.yml`), which qmd syncs into the index on every open. The package is
 * imported only when a qmd verb runs: the import alone costs about 48 ms, and
 * hooks must never pay it.
 *
 * The install exposes this same package's `qmd` command, so each host has one
 * qmd version writing the shared index.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { QMDStore } from "@tobilu/qmd";
import type { MemoryScope } from "./memory.ts";

export type Env = Record<string, string | undefined>;

export interface QmdLocation {
  dbPath: string;
  /** qmd's YAML config, when it exists. */
  configPath?: string;
}

function home(env: Env): string {
  return env.HOME || homedir();
}

/** Where the `qmd` command keeps its index and config, for this environment. */
export function qmdLocation(env: Env): QmdLocation {
  const dbPath =
    env.INDEX_PATH || join(env.XDG_CACHE_HOME || join(home(env), ".cache"), "qmd", "index.sqlite");
  const configDir =
    env.QMD_CONFIG_DIR ||
    (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "qmd") : join(home(env), ".config", "qmd"));
  const configPath = join(configDir, "index.yml");
  return existsSync(configPath) ? { dbPath, configPath } : { dbPath };
}

/**
 * Open the qmd store. Close it with `store.close()`. With `syncConfig`, qmd's
 * YAML config is synced into the index first, as every `qmd` command does;
 * without it the store uses the collections the index already holds, so a
 * read never writes the config into the index.
 */
export async function openQmd(location: QmdLocation, syncConfig: boolean): Promise<QMDStore> {
  const { createStore } = await import("@tobilu/qmd");
  return createStore(
    syncConfig && location.configPath
      ? { dbPath: location.dbPath, configPath: location.configPath }
      : { dbPath: location.dbPath },
  );
}

/** A qmd collection that the store does not have. */
export class QmdCollectionMissing extends Error {
  override name = "QmdCollectionMissing";
}

async function requireCollection(store: QMDStore, collection: string): Promise<void> {
  const names = (await store.listCollections()).map((entry) => entry.name);
  if (!names.includes(collection)) {
    throw new QmdCollectionMissing(
      `qmd collection '${collection}' not found (collections: ${names.join(", ") || "none"})`,
    );
  }
}

/** Collection-relative paths of the active documents in `collection`, or null without it. */
export async function indexedPaths(
  store: QMDStore,
  collection: string,
): Promise<Set<string> | null> {
  try {
    await requireCollection(store, collection);
  } catch (error) {
    if (error instanceof QmdCollectionMissing) return null;
    throw error;
  }
  // The query `qmd ls` and qmd's own `getActiveDocumentPaths` use.
  const rows = store.internal.db
    .prepare("SELECT path FROM documents WHERE collection = ? AND active = 1")
    .all(collection) as { path: string }[];
  return new Set(rows.map((row) => row.path));
}

/**
 * One vector per active document of `collection`, keyed by collection-relative
 * path: the mean of the document's stored chunk vectors, scaled to length 1.
 * Returns null without the collection. Reads what `qmd embed` stored and
 * loads no model, so it is cheap; a document without vectors is left out.
 * Throws when the index has no vector table (nothing was ever embedded).
 *
 * Like `indexedPaths`, this uses qmd's internal tables (`documents`,
 * `content_vectors`, and the sqlite-vec table `vectors_vec`, whose rows are
 * keyed `<hash>_<seq>`). `vectors_vec` is read one key at a time: a join
 * with it can hang.
 */
export async function documentVectors(
  store: QMDStore,
  collection: string,
): Promise<Map<string, Float32Array> | null> {
  try {
    await requireCollection(store, collection);
  } catch (error) {
    if (error instanceof QmdCollectionMissing) return null;
    throw error;
  }
  const { db } = store.internal;
  const chunks = db
    .prepare(
      `SELECT d.path AS path, cv.hash AS hash, cv.seq AS seq
       FROM documents d JOIN content_vectors cv ON cv.hash = d.hash
       WHERE d.collection = ? AND d.active = 1
       ORDER BY d.path, cv.seq`,
    )
    .all(collection) as { path: string; hash: string; seq: number }[];
  const byKey = db.prepare("SELECT embedding FROM vectors_vec WHERE hash_seq = ?");
  const sums = new Map<string, Float32Array>();
  for (const { path, hash, seq } of chunks) {
    const row = byKey.get(`${hash}_${seq}`) as { embedding: Uint8Array } | null;
    if (row === null) continue;
    const { buffer, byteOffset, byteLength } = row.embedding;
    const vector = new Float32Array(buffer.slice(byteOffset, byteOffset + byteLength));
    const sum = sums.get(path);
    if (sum === undefined) sums.set(path, vector);
    else if (sum.length === vector.length)
      sums.set(
        path,
        sum.map((x, i) => x + (vector[i] ?? 0)),
      );
  }
  for (const [path, sum] of sums) {
    const length = Math.hypot(...sum);
    if (length === 0) sums.delete(path);
    else
      sums.set(
        path,
        sum.map((x) => x / length),
      );
  }
  return sums;
}

/**
 * Documents in the whole index (every collection) whose vectors are missing
 * or incomplete for the default embedding model: what `qmd embed` would do.
 * The SDK exposes only the index-wide count.
 */
export function unembeddedCount(store: QMDStore): number {
  return store.internal.getHashesNeedingEmbedding();
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  line: number;
  snippet: string;
}

/**
 * How to search: keyword (BM25, no model), semantic (vector similarity; the
 * embedding model only), or hybrid (qmd's full pipeline: query expansion,
 * keyword and vector retrieval, and reranking; three models).
 */
export type SearchMode = "keyword" | "semantic" | "hybrid";

/**
 * Search one collection in `mode`. The first model-backed call in a
 * process loads its models; on an M-series Mac a semantic search then takes about
 * 0.8 s, a hybrid one 13 to 22 s.
 */
export async function search(
  store: QMDStore,
  query: string,
  options: { collection: string; limit: number; mode: SearchMode },
): Promise<SearchHit[]> {
  await requireCollection(store, options.collection);
  const { extractSnippet } = await import("@tobilu/qmd");
  const prefix = `qmd://${options.collection}/`;
  const relative = (file: string): string =>
    file.startsWith(prefix) ? file.slice(prefix.length) : file;
  const hit = (
    file: string,
    title: string,
    score: number,
    body: string,
    chunk?: number,
  ): SearchHit => {
    const { line, snippet } = extractSnippet(body, query, 300, chunk);
    return { path: relative(file), title, score: Math.round(score * 100) / 100, line, snippet };
  };
  const scope = { collection: options.collection, limit: options.limit };
  if (options.mode === "hybrid") {
    const results = await store.search({ query, ...scope });
    return results.map((r) => hit(r.file, r.title, r.score, r.body, r.bestChunkPos));
  }
  if (options.mode === "semantic") {
    const results = await store.searchVector(query, scope);
    return results.map((r) => hit(r.filepath, r.title, r.score, r.body ?? "", r.chunkPos));
  }
  const results = await store.searchLex(query, scope);
  return results.map((r) => hit(r.filepath, r.title, r.score, r.body ?? ""));
}

/**
 * Search the memory notes of `scope`. qmd has no path filter, so this asks
 * for more hits than `limit` and keeps the topic notes directly in the
 * scope's folder: a subfolder (such as Hermes's own `hermes/` store) holds
 * facts for one agent only.
 */
export async function searchMemory(
  store: QMDStore,
  scope: MemoryScope,
  query: string,
  options: { collection: string; limit: number; mode: SearchMode },
): Promise<SearchHit[]> {
  const hits = await search(store, query, {
    ...options,
    limit: Math.min(options.limit * 10, 200),
  });
  const prefix = `${scope.dir}/`.toLowerCase();
  const index = scope.index.toLowerCase();
  return hits
    .filter((hit) => {
      const path = hit.path.toLowerCase();
      return path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && path !== index;
    })
    .slice(0, options.limit);
}

/** Another process holds the embed lock. */
export class EmbedLockBusy extends Error {
  override name = "EmbedLockBusy";
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/**
 * Hold qmd's embed lock file (`.qmd-embed.lock` beside the index) while
 * `work` runs, so two embeds never race on the vector table. A lock whose
 * process is gone is taken over.
 */
async function withEmbedLock<T>(dbPath: string, work: () => Promise<T>): Promise<T> {
  const lock = join(dirname(dbPath), ".qmd-embed.lock");
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST" || attempt > 0) {
        throw (error as { code?: unknown }).code === "EEXIST"
          ? new EmbedLockBusy(`another process holds ${lock}`)
          : error;
      }
      const holder = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
      if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) {
        throw new EmbedLockBusy(`another process (pid ${holder}) holds ${lock}`);
      }
      unlinkSync(lock);
    }
  }
  try {
    return await work();
  } finally {
    try {
      if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock);
    } catch {
      // Already gone.
    }
  }
}

export interface ReindexResult {
  update: { indexed: number; updated: number; unchanged: number; removed: number; skipped: number };
  /** `null` when the embed step was skipped (`embed: false`). */
  embed: {
    docsProcessed: number;
    chunksEmbedded: number;
    errors: number;
    durationMs: number;
  } | null;
  /** `null` when the embed step, and with it cleanup, was skipped. */
  cleanup: {
    cacheCount: number;
    orphanedVectors: number;
    inactiveDocs: number;
    orphanedContent: number;
  } | null;
}

/**
 * Bring `collection` up to date: scan its files (`qmd update`), embed the
 * documents that need vectors (`qmd embed`), then run qmd's cleanup (`qmd
 * cleanup`: LLM cache, orphaned vectors, inactive documents, orphaned
 * content, FTS compaction, vacuum). Cleanup covers the whole index.
 *
 * With `embed: false` only the scan runs: the keyword index is current, no
 * model loads, and vectors for changed documents wait for a full reindex.
 */
export async function reindex(
  store: QMDStore,
  dbPath: string,
  collection: string,
  options: { embed?: boolean } = {},
): Promise<ReindexResult> {
  await requireCollection(store, collection);
  const scanned = await store.update({ collections: [collection] });
  const update = {
    indexed: scanned.indexed,
    updated: scanned.updated,
    unchanged: scanned.unchanged,
    removed: scanned.removed,
    skipped: scanned.skipped,
  };
  if (options.embed === false) return { update, embed: null, cleanup: null };
  const embed = await withEmbedLock(dbPath, () => store.embed({ collection }));
  const { Maintenance } = await import("@tobilu/qmd");
  const cleanup = new Maintenance(store.internal).run();
  return {
    update,
    embed: {
      docsProcessed: embed.docsProcessed,
      chunksEmbedded: embed.chunksEmbedded,
      errors: embed.errors,
      durationMs: embed.durationMs,
    },
    cleanup,
  };
}
