/**
 * The one lock of llmOS: an exclusive SQLite transaction on a lock file.
 * The kernel gives it to one process at a time and drops it when the holder
 * exits or crashes, so no code ever has to judge a lock stale or remove a
 * lock file. The file stays on disk, empty; only its kernel lock matters.
 * It guards the memory project lock (`memory.ts`), the memory-sync lock
 * (`hooks/sync.ts`), and the service start lock (`service.ts`).
 *
 * SQLite follows a symbolic link at the path, so `tryLock` refuses a path
 * that is a link or not a regular file. The lock file is created in the same
 * step with `O_NOFOLLOW`.
 */

import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, openSync } from "node:fs";

/** The lock path is a symbolic link or not a regular file; nothing was opened. */
export class LockRefused extends Error {
  override name = "LockRefused";
}

export interface HeldLock {
  /**
   * End the transaction, which frees the lock. A HeldLock that is garbage
   * collected frees its lock too, so keep the reference until release.
   */
  release(): void;
}

function checkedFile(path: string): void {
  try {
    closeSync(openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600));
    if (!lstatSync(path).isFile()) throw new LockRefused(`${path} is not a regular file`);
  } catch (error) {
    if (error instanceof LockRefused) throw error;
    if ((error as { code?: unknown }).code === "ELOOP") {
      throw new LockRefused(`${path} is a symbolic link`);
    }
    if ((error as { code?: unknown }).code === "EISDIR") {
      throw new LockRefused(`${path} is not a regular file`);
    }
    throw error;
  }
}

/** Take the lock at `path` once; `null` while another holder has it. */
export function tryLock(path: string): HeldLock | null {
  checkedFile(path);
  const db = new Database(path);
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
