/**
 * The llmOS vault's folder layout (ADR 0013). Paths are vault-relative.
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

/** Whether a vault-relative path is an inbox drop: a note in `raw/` that is no capture. */
export function isInboxDrop(path: string): boolean {
  return path.startsWith(`${RAW_DIR}/`) && !CAPTURE_NOTE.test(path);
}

/** Whether a vault-relative path is a shared project memory note (ADR-0020). */
export function isMemoryNote(path: string): boolean {
  return MEMORY_NOTE.test(path);
}
