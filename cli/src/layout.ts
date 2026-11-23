/**
 * The llmOS vault's folder layout. Paths are vault-relative.
 * `raw/` holds captured sources, each a `raw/<slug>/source.md` beside its
 * page and assets, and the inbox: every other note in `raw/`.
 */

export const DAILY_DIR = "daily";
export const RAW_DIR = "raw";
export const MEMORY_DIR = "memory";
export const MEMORY_INDEX = "MEMORY.md";
export const TEMPLATES_DIR = "categories/templates";
export const SCHEMA_NOTE = "schema.md";
export const AUTHORING_NOTE = "authoring.md";
export const INGEST_CONTRACT_NOTE = "ingest-contract.md";

/** A captured source's note: `raw/<slug>/source.md`. */
export const CAPTURE_NOTE = /^raw\/[^/]+\/source\.md$/;

/** Shared per-project working memory notes: `projects/<project>/memory/<...>.md`. */
export const MEMORY_NOTE = /^projects\/[^/]+\/memory\/.+\.md$/;

/**
 * Any file in a project's memory folder: what the memory sync commits and
 * pushes. Wider than `MEMORY_NOTE`, which takes only Markdown notes.
 */
export const SHARED_MEMORY_PATH = /^projects\/[^/]+\/memory\/.+/;

/** A daily note, `daily/<YYYY-MM-DD>.md`, which the digest writes. */
export const DAILY_NOTE = /^daily\/\d{4}-\d{2}-\d{2}\.md$/;

/** Whether a vault-relative path is an inbox drop: a note in `raw/` that is no capture. */
export function isInboxDrop(path: string): boolean {
  return path.startsWith(`${RAW_DIR}/`) && !CAPTURE_NOTE.test(path);
}

/** Whether a vault-relative path is a shared project memory note. */
export function isMemoryNote(path: string): boolean {
  return MEMORY_NOTE.test(path);
}
