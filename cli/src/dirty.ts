/**
 * The dirty flag: a vault changed since the Stop hook last reindexed the
 * `llmos` collection. It is one file per vault, `dirty/<vault hash>` in the
 * llmOS state folder (`heartbeat.ts` `stateDir`), shared by every process of
 * the user, because an MCP server or CLI process does not know the harness
 * session, and every session shares the index. The hash is of the vault root
 * with its symbolic links resolved (`hooks/common.ts` `realpath`), so every
 * writer and the Stop hook name the same file.
 *
 * Every vault write sets it: the headless writes (`write.ts`), a source
 * capture (`sources.ts`), an obsidian-cli write (`obsidian.ts`), and the
 * PostToolUse stamp hook for a harness's own file writes. The Stop hook reads
 * its token, reindexes, and clears it only when the reindex succeeded and no
 * write set it again meanwhile.
 *
 * The flag's folder must be a real folder owned by this user that no other
 * user can write, or nothing is read or written there. The flag is written to
 * a new private file and renamed into place, and read without following a
 * symbolic link, so a link planted at its path is replaced, never followed.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./heartbeat.ts";
import { realpath } from "./hooks/common.ts";

type Env = Record<string, string | undefined>;

/** The flag of the vault at `root`. */
export function flagPath(root: string, env: Env = process.env): string {
  const key = createHash("sha256").update(realpath(root)).digest("hex").slice(0, 16);
  return join(stateDir(env), "dirty", key);
}

/** The flag's folder, made private when missing; throws unless no other user can change it. */
function safeFolder(flag: string): string {
  const folder = dirname(flag);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = lstatSync(folder);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || stat.mode & 0o022) {
    throw new Error(`${folder} is not a private folder of this user; dirty flag not used`);
  }
  return folder;
}

function missing(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ENOENT";
}

/** The text of the file at `path`, read without following a symbolic link. */
function readNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Set the flag of the vault at `root` with a new token. Never throws: the
 * write it records is done, and a lost flag only delays search until the
 * next reindex.
 */
export function markDirty(root: string): void {
  try {
    const flag = flagPath(root);
    const temporary = join(safeFolder(flag), `.${process.pid}.${crypto.randomUUID()}`);
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, `${crypto.randomUUID()}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, flag);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
  } catch {}
}

/** The flag's token for the vault at `root`, or `null` when the vault is clean. */
export function dirtyToken(root: string): string | null {
  const flag = flagPath(root);
  safeFolder(flag);
  try {
    return readNoFollow(flag);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/**
 * Clear the flag of the vault at `root` after a successful reindex that
 * started when the flag held `token`. A write during the reindex left another
 * token, so the flag stays. The rename makes the check and the removal one
 * step that no write can split.
 */
export function clearDirty(root: string, token: string): void {
  const flag = flagPath(root);
  const claim = join(safeFolder(flag), `.claim.${process.pid}`);
  try {
    renameSync(flag, claim);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (readNoFollow(claim) === token) rmSync(claim);
  else renameSync(claim, flag);
}
