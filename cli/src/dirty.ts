/**
 * The dirty flag: the vault changed since the Stop hook last reindexed the
 * `llmos` collection. It is one file, `<tmpdir>/llmos-hooks/llmos.dirty`,
 * shared by every process of the user, because an MCP server or CLI process
 * does not know the harness session, and the index is shared by every session.
 *
 * Every vault write sets it: the headless writes (`write.ts`), a source
 * capture (`sources.ts`), an obsidian-cli write (`obsidian.ts`), and the
 * PostToolUse stamp hook for a harness's own file writes. The Stop hook reads
 * its token, reindexes, and clears it only when the reindex succeeded and no
 * write set it again meanwhile.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function flagPath(): string {
  return join(tmpdir(), "llmos-hooks", "llmos.dirty");
}

function missing(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Set the flag with a new token. Never throws: the write it records is done,
 * and a lost flag only delays search until the next reindex.
 */
export function markDirty(): void {
  try {
    const flag = flagPath();
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(flag, `${process.pid} ${crypto.randomUUID()}\n`);
  } catch {}
}

/** The flag's token, or `null` when the vault is clean. */
export function dirtyToken(): string | null {
  try {
    return readFileSync(flagPath(), "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/**
 * Clear the flag after a successful reindex that started when the flag held
 * `token`. A write during the reindex left another token, so the flag stays.
 * The rename makes the check and the removal one step that no write can split.
 */
export function clearDirty(token: string): void {
  const flag = flagPath();
  const claim = `${flag}.${process.pid}`;
  try {
    renameSync(flag, claim);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (readFileSync(claim, "utf8") === token) rmSync(claim);
  else renameSync(claim, flag);
}
