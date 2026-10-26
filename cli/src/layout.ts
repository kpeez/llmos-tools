/**
 * The llmOS vault's folder layout (ADR 0013). Paths are vault-relative.
 * `raw/` holds captured sources, each a `raw/<slug>/source.md` beside its
 * page and assets, and the inbox: every other note in `raw/`.
 */

export const DAILY_DIR = "daily";
export const RAW_DIR = "raw";
export const TEMPLATES_DIR = "categories/templates";
export const SCHEMA_NOTE = "schema.md";
export const AUTHORING_NOTE = "authoring.md";
export const INGEST_CONTRACT_NOTE = "ingest-contract.md";

/** A captured source's note: `raw/<slug>/source.md`. */
export const CAPTURE_NOTE = /^raw\/[^/]+\/source\.md$/;

/** Whether a vault-relative path is an inbox drop: a note in `raw/` that is no capture. */
export function isInboxDrop(path: string): boolean {
  return path.startsWith(`${RAW_DIR}/`) && !CAPTURE_NOTE.test(path);
}
