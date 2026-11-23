/**
 * Shared project memory sync: every host sees the same
 * `projects/<project>/memory/` files through the vault's Git remote.
 *
 * Every git call goes through `../git.ts`, which never rewrites a work tree
 * the user is editing: new commits are built without the work tree, `main`
 * moves only with `git merge --ff-only`, which keeps unrelated dirty edits
 * and refuses, rather than overwrites, when one overlaps an incoming change,
 * and there is no `rebase`, `stash`, or `reset`. A dirty vault does not
 * pause sync.
 *
 * - Session start (`syncOnStart`, git.ts `update`) fetches `origin main`,
 *   then fast-forwards when `HEAD` is behind and not ahead, so the injected
 *   `MEMORY.md` is fresh. A refusal is one context line. A diverged branch
 *   is left for Stop.
 * - Stop (`syncOnStop`) finds work with local git commands only: changed
 *   memory paths and commits ahead of `origin/main`. With no work it never
 *   touches the network. Otherwise it commits only the memory paths; then
 *   git.ts `publish` fetches, fast-forwards (behind) or merges (ahead and
 *   behind; a conflict warns and changes nothing on disk). It reads `HEAD`
 *   and `origin/main` once and uses those commit IDs for every later step, checks that each unpushed
 *   commit and the net change touch only shared memory, and pushes that
 *   exact commit to `main`. A skip or failure is one stderr warning; the
 *   commit stays local and the next Stop retries it because the branch is
 *   ahead.
 *
 * One gate decides whether a checkout syncs (`LLMOS_NO_GIT_SYNC=1` opts out;
 * cloud sessions have their own path in `cloud.ts`; a vault without
 * `origin` or off `main` is left alone; a rebase, merge, or cherry-pick in
 * progress pauses sync and session start says so). Sync work runs under a
 * lock file in the git common dir, so concurrent sessions skip instead of
 * racing. Hook stdout is a protocol channel: every git call pipes its
 * output, and diagnostics go to stderr.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeSync,
} from "node:fs";
import {
  add,
  type Checkout,
  changedPaths,
  commit,
  hasUnpushed,
  mainCheckout,
  publish,
  update,
  vaultPath,
} from "../git.ts";
import { LOCAL_GIT_MS, START_GIT_MS, STOP_GIT_MS } from "../hook-limits.ts";
import { SHARED_MEMORY_PATH } from "../layout.ts";
import { joinPath } from "./common.ts";

type Env = Record<string, string | undefined>;

const LOCK_STALE_MS = 60_000;
const COMMIT_MESSAGE = "memory: sync shared project memory";
const MERGE_MESSAGE = "memory: merge shared project memory";

/** Where a checkout syncs, or why it does not. */
export type Gate = ({ sync: true } & Checkout) | { sync: false; reason: string; paused?: string };

function warn(message: string): void {
  process.stderr.write(`llmos sync: ${message}\n`);
}

/** The one decision whether this vault checkout syncs. */
export function syncGate(root: string, env: Env): Gate {
  if (env.LLMOS_NO_GIT_SYNC === "1") return { sync: false, reason: "LLMOS_NO_GIT_SYNC=1" };
  if (env.CLAUDE_CODE_REMOTE === "true") return { sync: false, reason: "cloud session" };
  const opened = mainCheckout(root, env, LOCAL_GIT_MS);
  if (!opened.ok) return { sync: false, reason: opened.reason, paused: opened.paused };
  return { sync: true, ...opened.checkout };
}

function statSafe(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Create the lock file holding `token`; false when a live lock exists. */
function create(path: string, token: string): boolean {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, token);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the lock and return this run's token, or `null` when another run holds
 * it. A lock older than 60 s is stale: it is renamed to a unique name before
 * removal, so only the run whose rename succeeds creates the new lock.
 */
function acquire(path: string): string | null {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (create(path, token)) return token;
    const info = statSafe(path);
    if (info !== null && Date.now() - info.mtimeMs <= LOCK_STALE_MS) return null;
    const taken = `${path}.${process.pid}.${randomUUID()}`;
    try {
      renameSync(path, taken);
    } catch {
      continue; // Another run took it over; the next create sees its fresh lock.
    }
    const held = statSafe(taken);
    if (held !== null && Date.now() - held.mtimeMs <= LOCK_STALE_MS) {
      // The rename took a live lock a rival had just created: put it back.
      try {
        linkSync(taken, path);
      } catch {
        // A newer lock exists already.
      }
      rmSync(taken, { force: true });
      return null;
    }
    rmSync(taken, { force: true });
  }
  return null;
}

/** Remove the lock only while it still holds this run's token. */
function release(path: string, token: string): void {
  try {
    if (readFileSync(path, "utf8") === token) rmSync(path, { force: true });
  } catch {
    // Already gone.
  }
}

/** Run `work` under the checkout's lock; skip quietly when another run holds it. */
function withLock<T>(commonDir: string, work: () => T): T | null {
  const path = joinPath(commonDir, "llmos-sync.lock");
  const token = acquire(path);
  if (token === null) return null;
  try {
    return work();
  } finally {
    release(path, token);
  }
}

type Syncing = Extract<Gate, { sync: true }>;

/** Fetch at session start, then fast-forward when behind only; a context line or `null`. */
export function syncOnStart(root: string, env: Env): string | null {
  const gate = syncGate(root, env);
  if (!gate.sync) {
    return gate.paused
      ? `The llmOS vault has a ${gate.paused} in progress, so shared memory sync is paused.`
      : null;
  }
  return withLock(gate.commonDir, () => {
    const updated = update(gate, START_GIT_MS);
    if (!("failed" in updated) || updated.failed === "diverged") return null; // Diverged: Stop merges.
    if (updated.failed === "fetch") {
      return `The llmOS vault fetch failed: ${updated.reason}. Shared memory may be stale.`;
    }
    return `The llmOS vault could not fast-forward: ${updated.reason}. Shared memory may be stale.`;
  });
}

/** The changed memory paths, repository-relative, from `git status -z` (renames list both paths). */
function changedMemoryPaths(gate: Syncing): string[] {
  const projects = gate.vaultRel === "." ? "projects" : `${gate.vaultRel}/projects`;
  return changedPaths(gate, projects).filter((path) => {
    const inVault = vaultPath(gate, path);
    return inVault !== null && SHARED_MEMORY_PATH.test(inVault);
  });
}

/** Commit changed memory files, merge, and push; no network unless there is work. */
export function syncOnStop(root: string, env: Env): void {
  const gate = syncGate(root, env);
  if (!gate.sync) return;
  const paths = changedMemoryPaths(gate);
  if (paths.length === 0 && !hasUnpushed(gate)) return;
  withLock(gate.commonDir, () => {
    if (paths.length > 0) {
      const addError = add(gate, paths);
      if (addError) return warn(`git add failed: ${addError}`);
      const commitError = commit(gate, paths, COMMIT_MESSAGE);
      if (commitError) return warn(`memory commit failed: ${commitError}`);
    }
    const published = publish(gate, {
      allowed: (path) => SHARED_MEMORY_PATH.test(path),
      mergeMessage: MERGE_MESSAGE,
      timeouts: STOP_GIT_MS,
    });
    if (!("failed" in published)) return;
    switch (published.failed) {
      case "fetch":
        return warn(`fetch failed, the memory commit stays local: ${published.reason}`);
      case "read":
        return warn(published.reason);
      case "fast-forward":
        return warn(`${published.reason}; shared memory may be stale`);
      case "merge":
        return warn(`${published.reason}; the memory commit stays local`);
      case "check":
        return warn(
          `not pushing: unpushed commits also touch ${published.paths.slice(0, 3).join(", ")}; push them by hand`,
        );
      case "push":
        return warn(`push failed, the memory commit stays local: ${published.reason}`);
    }
  });
}
