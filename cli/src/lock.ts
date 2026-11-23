/**
 * The one lock of llmOS: an exclusive SQLite transaction on a lock file.
 * The kernel gives it to one process at a time and drops it when the holder
 * exits or crashes, so no code ever has to judge a lock stale or remove a
 * lock file. The file stays on disk, empty; only its kernel lock matters.
 * It guards the memory project lock (`memory.ts`), the memory-sync lock
 * (`hooks/sync.ts`), and the service start lock (`service.ts`).
 */

import { Database } from "bun:sqlite";

export interface HeldLock {
  /** End the transaction, which frees the lock. */
  release(): void;
}

/** Take the lock at `path` once; `null` while another holder has it. */
export function tryLock(path: string): HeldLock | null {
  const db = new Database(path, { create: true });
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if ((error as { code?: unknown }).code === "SQLITE_BUSY") return null;
    throw error;
  }
  return { release: () => db.close() };
}

/** Take the lock at `path`, trying every 5 ms for up to `waitMs`; `null` on a timeout. */
export function waitLock(path: string, waitMs: number): HeldLock | null {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const held = tryLock(path);
    if (held !== null || Date.now() >= deadline) return held;
    Bun.sleepSync(5);
  }
}
