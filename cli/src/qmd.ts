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

import type { QMDStore } from "@tobilu/qmd";
import type { MemoryScope } from "./memory.ts";
import {
  type Env,
  MEMORY_COLLECTION,
  MEMORY_PATTERN,
  type QmdLocation,
  qmdLocation,
} from "./qmd-location.ts";

export { type Env, MEMORY_COLLECTION, MEMORY_PATTERN, type QmdLocation, qmdLocation };

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
 * Like `indexedPaths`, this uses qmd's internal tables (qmd 2.9.0 layout):
 * `documents`, `vector_collection_ids` (collection name to id), `vector_rows`
 * (one row per chunk and collection, with `hash`, `seq`, `collection_id`), and
 * the sqlite-vec table `vectors_by_collection`, whose rowid is
 * `vector_rows.id`. qmd converts an older `vectors_vec` index when it opens
 * the index; where that conversion cannot run (no sqlite-vec), the new table
 * is missing and this throws. `vectors_by_collection` is read one rowid at a
 * time: a join with it can hang.
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
      `SELECT d.path AS path, vr.id AS id
       FROM documents d
       JOIN vector_collection_ids vc ON vc.name = d.collection
       JOIN vector_rows vr ON vr.hash = d.hash AND vr.collection_id = vc.id
       WHERE d.collection = ? AND d.active = 1
       ORDER BY d.path, vr.seq`,
    )
    .all(collection) as { path: string; id: number }[];
  const byRowid = db.prepare("SELECT embedding FROM vectors_by_collection WHERE rowid = ?");
  const sums = new Map<string, Float32Array>();
  for (const { path, id } of chunks) {
    const row = byRowid.get(id) as { embedding: Uint8Array } | null;
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

/** Runs one search; `search` over a store, or the warm service's answer. */
export type Searcher = (
  query: string,
  options: { collection: string; limit: number; mode: SearchMode },
) => Promise<SearchHit[]>;

/** The searcher of an open store. */
export function storeSearcher(store: QMDStore): Searcher {
  return (query, options) => search(store, query, options);
}

/**
 * Search the memory notes of `scope`. qmd has no path filter, so this asks
 * for more hits than `limit` and keeps the notes of the scope's folder, never
 * its index. In the `memory` collection that is all the filtering there is.
 * Any other collection (the `llmos` fallback, while the `memory` collection
 * is missing) also holds the subfolders of the memory folder, which are not
 * shared memory, so this keeps only the topic notes directly in the folder.
 */
export async function searchMemory(
  searcher: Searcher,
  scope: MemoryScope,
  query: string,
  options: { collection: string; limit: number; mode: SearchMode },
): Promise<SearchHit[]> {
  const hits = await searcher(query, {
    ...options,
    limit: Math.min(options.limit * 10, 200),
  });
  const prefix = `${scope.dir}/`.toLowerCase();
  const index = scope.index.toLowerCase();
  const topLevelOnly = options.collection !== MEMORY_COLLECTION;
  return hits
    .filter((hit) => {
      const path = hit.path.toLowerCase();
      if (!path.startsWith(prefix) || path === index) return false;
      return !topLevelOnly || !path.slice(prefix.length).includes("/");
    })
    .slice(0, options.limit);
}

/**
 * Search memory in the `memory` collection, else in `llmos` while the
 * `memory` collection is missing.
 */
export async function searchMemoryNotes(
  searcher: Searcher,
  scope: MemoryScope,
  query: string,
  options: { limit: number; mode: SearchMode },
): Promise<SearchHit[]> {
  try {
    return await searchMemory(searcher, scope, query, {
      ...options,
      collection: MEMORY_COLLECTION,
    });
  } catch (error) {
    if (!(error instanceof QmdCollectionMissing)) throw error;
    return searchMemory(searcher, scope, query, { ...options, collection: "llmos" });
  }
}

/**
 * Active documents of `collection` that have no stored vector at all. A
 * coarser count than `unembeddedCount`: a document with only some of its
 * chunks embedded counts as embedded. 0 without the collection.
 */
export function unembeddedIn(store: QMDStore, collection: string): number {
  const row = store.internal.db
    .prepare(
      `SELECT COUNT(DISTINCT d.hash) AS count FROM documents d
       WHERE d.collection = ? AND d.active = 1
         AND NOT EXISTS (SELECT 1 FROM content_vectors cv WHERE cv.hash = d.hash)`,
    )
    .get(collection) as { count: number };
  return row.count;
}

/**
 * Whether `error` is qmd's `EmbedLockBusyError`: another process is embedding
 * this index. qmd's `store.embed` takes its own exclusive lock; a caller backs
 * off or retries. Matched by name so the package stays a lazy import.
 */
export function isEmbedLockBusy(error: unknown): boolean {
  return error instanceof Error && error.name === "EmbedLockBusyError";
}

type ScanCounts = {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
};

export interface ReindexResult {
  update: ScanCounts;
  /**
   * The scan of the `memory` collection, which a reindex of `llmos` runs too
   * when that collection exists; `null` otherwise.
   */
  memory: ScanCounts | null;
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
 *
 * A reindex of `llmos` also scans the `memory` collection when it exists:
 * memory search reads only that collection, and its notes change outside
 * `llmos memory` too (Claude Code's own writes, the memory sync, hand edits).
 * Embedding `llmos` covers them, since qmd keys vectors by content hash.
 */
export async function reindex(
  store: QMDStore,
  collection: string,
  options: { embed?: boolean } = {},
): Promise<ReindexResult> {
  await requireCollection(store, collection);
  const scan = async (name: string): Promise<ScanCounts> => {
    const scanned = await store.update({ collections: [name] });
    return {
      indexed: scanned.indexed,
      updated: scanned.updated,
      unchanged: scanned.unchanged,
      removed: scanned.removed,
      skipped: scanned.skipped,
    };
  };
  const update = await scan(collection);
  const names = (await store.listCollections()).map((entry) => entry.name);
  const memory =
    collection === "llmos" && names.includes(MEMORY_COLLECTION)
      ? await scan(MEMORY_COLLECTION)
      : null;
  if (options.embed === false) return { update, memory, embed: null, cleanup: null };
  const embed = await store.embed({ collection });
  const { Maintenance } = await import("@tobilu/qmd");
  const cleanup = new Maintenance(store.internal).run();
  return {
    update,
    memory,
    embed: {
      docsProcessed: embed.docsProcessed,
      chunksEmbedded: embed.chunksEmbedded,
      errors: embed.errors,
      durationMs: embed.durationMs,
    },
    cleanup,
  };
}
