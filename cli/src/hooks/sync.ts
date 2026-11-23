/**
 * Shared project memory sync: every host sees the same
 * `projects/<project>/memory/` files through the vault's Git remote.
 *
 * Sync never rewrites a work tree the user is editing. It builds every new
 * commit without the work tree (`git merge-tree --write-tree` and
 * `git commit-tree`) and moves `main` only with `git merge --ff-only`, which
 * keeps unrelated dirty edits and refuses, rather than overwrites, when one
 * overlaps an incoming change. It never runs `rebase`, `stash`, or `reset`,
 * and a dirty vault does not pause it.
 *
 * - Session start (`syncOnStart`) fetches `origin main`, then fast-forwards
 *   when `HEAD` is behind and not ahead, so the injected `MEMORY.md` is
 *   fresh. A refusal is one context line. A diverged branch is left for Stop.
 * - Stop (`syncOnStop`) finds work with local git commands only: changed
 *   memory paths and commits ahead of `origin/main`. With no work it never
 *   touches the network. Otherwise it commits only the memory paths, fetches,
 *   fast-forwards (behind) or merges (ahead and behind; a conflict warns and
 *   changes nothing on disk). It reads `HEAD` and `origin/main` once and
 *   uses those commit IDs for every later step, checks that each unpushed
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
import { relative } from "node:path";
import { joinPath } from "./common.ts";

type Env = Record<string, string | undefined>;

// Session start has a 10 s hook timeout: fetch 4 s + fast-forward 4 s.
// Stop has 30 s: fetch 5 s + merge 5 s + push 5 s, plus local calls.
const START_FETCH_TIMEOUT_MS = 4_000;
const START_MERGE_TIMEOUT_MS = 4_000;
const STOP_FETCH_TIMEOUT_MS = 5_000;
const STOP_MERGE_TIMEOUT_MS = 5_000;
const PUSH_TIMEOUT_MS = 5_000;
const LOCAL_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 60_000;
const COMMIT_MESSAGE = "memory: sync shared project memory";
const MERGE_MESSAGE = "memory: merge shared project memory";
const IN_PROGRESS_MARKERS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"];

const PAUSED_NAMES: Record<string, string> = {
  "rebase-merge": "rebase",
  "rebase-apply": "rebase",
  MERGE_HEAD: "merge",
  CHERRY_PICK_HEAD: "cherry-pick",
};

/** Where a checkout syncs, or why it does not. */
export type Gate =
  | { sync: true; top: string; gitDir: string; commonDir: string; vaultRel: string }
  | { sync: false; reason: string; paused?: string };

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function git(cwd: string, args: string[], env: Env, timeout: number): GitResult {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", cwd, ...args],
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout,
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      timedOut: result.exitedDueToTimeout === true,
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error), timedOut: false };
  }
}

function failure(result: GitResult): string {
  if (result.timedOut) return "git timed out";
  // Git often names the files on the lines after the first, so keep up to three.
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    // `hint:` lines are git's advice, not the reason.
    .filter((line) => line && !line.startsWith("hint:"));
  return lines.slice(0, 3).join(" ") || "git failed";
}

/** The commit ID `ref` names now, or `null`. */
function revParse(gate: Syncing, env: Env, ref: string): string | null {
  const result = git(
    gate.top,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    env,
    LOCAL_TIMEOUT_MS,
  );
  return result.ok ? result.stdout.trim() || null : null;
}

function warn(message: string): void {
  process.stderr.write(`llmos sync: ${message}\n`);
}

/** The one decision whether this vault checkout syncs. */
export function syncGate(root: string, env: Env): Gate {
  if (env.LLMOS_NO_GIT_SYNC === "1") return { sync: false, reason: "LLMOS_NO_GIT_SYNC=1" };
  if (env.CLAUDE_CODE_REMOTE === "true") return { sync: false, reason: "cloud session" };
  const paths = git(
    root,
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
    env,
    LOCAL_TIMEOUT_MS,
  );
  const [top, gitDir, commonDir] = paths.stdout.trim().split("\n");
  if (!paths.ok || !top || !gitDir || !commonDir) {
    return { sync: false, reason: "not in a git work tree" };
  }
  if (!git(root, ["remote", "get-url", "origin"], env, LOCAL_TIMEOUT_MS).ok) {
    return { sync: false, reason: "no origin" };
  }
  const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"], env, LOCAL_TIMEOUT_MS);
  if (branch.stdout.trim() !== "main") return { sync: false, reason: "not on main" };
  for (const marker of IN_PROGRESS_MARKERS) {
    if (statSafe(joinPath(gitDir, marker))) {
      return { sync: false, reason: `${marker} in progress`, paused: PAUSED_NAMES[marker] };
    }
  }
  return { sync: true, top, gitDir, commonDir, vaultRel: relative(top, root) || "." };
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

/** `git fetch origin main`: it never changes the work tree, so a timeout kill is safe. */
function fetch(gate: Syncing, env: Env, timeout: number): string | null {
  const result = git(gate.top, ["fetch", "--quiet", "origin", "main"], env, timeout);
  return result.ok ? null : failure(result);
}

/**
 * `git merge --ff-only target`: it keeps unrelated dirty edits and refuses
 * rather than overwrites. Returns the reason on refusal. A timeout is not
 * reported when `HEAD` already reached the target.
 */
function fastForward(gate: Syncing, env: Env, target: string, timeout: number): string | null {
  const merged = git(gate.top, ["merge", "--ff-only", "--quiet", target], env, timeout);
  if (merged.ok) return null;
  if (merged.timedOut) {
    const want = git(
      gate.top,
      ["rev-parse", "--verify", `${target}^{commit}`],
      env,
      LOCAL_TIMEOUT_MS,
    );
    const head = git(gate.top, ["rev-parse", "HEAD"], env, LOCAL_TIMEOUT_MS);
    if (want.ok && head.ok && want.stdout.trim() === head.stdout.trim()) return null;
  }
  return failure(merged);
}

function count(gate: Syncing, env: Env, range: string): number {
  const result = git(gate.top, ["rev-list", "--count", range], env, LOCAL_TIMEOUT_MS);
  return result.ok ? Number(result.stdout.trim()) || 0 : 0;
}

/** Fetch at session start, then fast-forward when behind only; a context line or `null`. */
export function syncOnStart(root: string, env: Env): string | null {
  const gate = syncGate(root, env);
  if (!gate.sync) {
    return gate.paused
      ? `The llmOS vault has a ${gate.paused} in progress, so shared memory sync is paused.`
      : null;
  }
  return withLock(gate.commonDir, () => {
    const fetchError = fetch(gate, env, START_FETCH_TIMEOUT_MS);
    if (fetchError)
      return `The llmOS vault fetch failed: ${fetchError}. Shared memory may be stale.`;
    if (count(gate, env, "HEAD..origin/main") === 0) return null;
    if (count(gate, env, "origin/main..HEAD") > 0) return null; // Diverged: Stop merges.
    const refused = fastForward(gate, env, "origin/main", START_MERGE_TIMEOUT_MS);
    return refused
      ? `The llmOS vault could not fast-forward: ${refused}. Shared memory may be stale.`
      : null;
  });
}

function projectsDir(gate: Syncing): string {
  return gate.vaultRel === "." ? "projects" : `${gate.vaultRel}/projects`;
}

/** Matches a repository-relative path inside some `projects/<slug>/memory/`. */
function memoryPattern(gate: Syncing): RegExp {
  const prefix = projectsDir(gate).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${prefix}/[^/]+/memory/.+`);
}

/** The changed memory paths under `vaultRel`, from `git status -z` (renames list both paths). */
function changedMemoryPaths(gate: Syncing, env: Env): string[] {
  const projects = projectsDir(gate);
  const status = git(
    gate.top,
    ["status", "--porcelain", "-z", "-uall", "--", projects],
    env,
    LOCAL_TIMEOUT_MS,
  );
  if (!status.ok) return [];
  const memory = memoryPattern(gate);
  const entries = status.stdout.split("\0");
  const found = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (memory.test(path)) found.add(path);
    if (code.includes("R") || code.includes("C")) {
      const original = entries[++i] ?? "";
      if (memory.test(original)) found.add(original);
    }
  }
  return [...found];
}

/**
 * Paths outside shared memory that unpushed commits touch, ignoring merge
 * commits (their upstream side is not local work). Stop pushes only
 * memory, so another unpushed commit (a note the user has not chosen to
 * publish) blocks the push until the user pushes it by hand.
 */
function otherAheadPaths(gate: Syncing, env: Env, base: string, tip: string): string[] {
  // Each non-merge commit, and the net change, which also covers a file
  // added inside a merge commit.
  const log = git(
    gate.top,
    [
      "-c",
      "core.quotePath=false",
      "log",
      "--format=",
      "--name-only",
      "--no-renames",
      "--no-merges",
      `${base}..${tip}`,
    ],
    env,
    LOCAL_TIMEOUT_MS,
  );
  const net = git(
    gate.top,
    ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", base, tip],
    env,
    LOCAL_TIMEOUT_MS,
  );
  if (!log.ok || !net.ok) return ["(git log failed)"];
  const memory = memoryPattern(gate);
  const paths = `${log.stdout}\n${net.stdout}`.split("\n");
  return [...new Set(paths.filter((p) => p && !memory.test(p)))];
}

/**
 * Merge `origin` into `head` without the work tree (`merge-tree` computes the
 * tree, `commit-tree` makes the commit), then fast-forward `main` to the
 * merge. A conflict or a refusal changes nothing on disk. Both inputs are fixed commit IDs, so a fetch or commit by
 * another writer meanwhile makes the fast-forward or the push refuse instead
 * of producing a merge that drops that work.
 */
function mergeDiverged(
  gate: Syncing,
  env: Env,
  head: string,
  origin: string,
): { id: string } | { error: string } {
  const tree = git(
    gate.top,
    ["-c", "core.quotePath=false", "merge-tree", "--write-tree", "--name-only", origin, head],
    env,
    LOCAL_TIMEOUT_MS,
  );
  const lines = tree.stdout.split("\n");
  if (!tree.ok) {
    if (tree.timedOut || !lines[0]) return { error: `merge failed: ${failure(tree)}` };
    const blank = lines.indexOf("");
    const paths = lines.slice(1, blank === -1 ? undefined : blank).slice(0, 3);
    return { error: `merge conflict in ${paths.join(", ") || "the vault"}` };
  }
  const commit = git(
    gate.top,
    ["commit-tree", lines[0] ?? "", "-p", head, "-p", origin, "-m", MERGE_MESSAGE],
    env,
    LOCAL_TIMEOUT_MS,
  );
  const id = commit.stdout.trim();
  if (!commit.ok || !id) return { error: `merge commit failed: ${failure(commit)}` };
  const refused = fastForward(gate, env, id, STOP_MERGE_TIMEOUT_MS);
  return refused ? { error: refused } : { id };
}

/** Commit changed memory files, merge, and push; no network unless there is work. */
export function syncOnStop(root: string, env: Env): void {
  const gate = syncGate(root, env);
  if (!gate.sync) return;
  const paths = changedMemoryPaths(gate, env);
  if (paths.length === 0 && count(gate, env, "origin/main..HEAD") === 0) return;
  withLock(gate.commonDir, () => {
    const { top } = gate;
    if (paths.length > 0) {
      const added = git(
        top,
        ["--literal-pathspecs", "add", "-A", "--", ...paths],
        env,
        LOCAL_TIMEOUT_MS,
      );
      if (!added.ok) return warn(`git add failed: ${failure(added)}`);
      const committed = git(
        top,
        ["--literal-pathspecs", "commit", "--quiet", "-m", COMMIT_MESSAGE, "--", ...paths],
        env,
        LOCAL_TIMEOUT_MS,
      );
      if (!committed.ok) {
        // Leave the user's index as it was before this run.
        git(
          top,
          ["--literal-pathspecs", "restore", "--staged", "--", ...paths],
          env,
          LOCAL_TIMEOUT_MS,
        );
        return warn(`memory commit failed: ${failure(committed)}`);
      }
    }
    const fetchError = fetch(gate, env, STOP_FETCH_TIMEOUT_MS);
    if (fetchError) return warn(`fetch failed, the memory commit stays local: ${fetchError}`);
    // Fix both commit IDs once: every later step uses these, never the names.
    const origin = revParse(gate, env, "origin/main");
    let tip = revParse(gate, env, "HEAD");
    if (origin === null || tip === null) return warn("could not read HEAD or origin/main");
    const behind = count(gate, env, `${tip}..${origin}`) > 0;
    const ahead = count(gate, env, `${origin}..${tip}`) > 0;
    if (behind && !ahead) {
      const refused = fastForward(gate, env, origin, STOP_MERGE_TIMEOUT_MS);
      if (refused) warn(`${refused}; shared memory may be stale`);
      return;
    }
    if (!ahead) return;
    if (behind) {
      const merged = mergeDiverged(gate, env, tip, origin);
      if ("error" in merged) return warn(`${merged.error}; the memory commit stays local`);
      tip = merged.id;
    }
    const others = otherAheadPaths(gate, env, origin, tip);
    if (others.length > 0) {
      return warn(
        `not pushing: unpushed commits also touch ${others.slice(0, 3).join(", ")}; push them by hand`,
      );
    }
    // Push the checked commit itself, not whatever HEAD names by now.
    const pushed = git(
      top,
      ["push", "--quiet", "origin", `${tip}:refs/heads/main`],
      env,
      PUSH_TIMEOUT_MS,
    );
    if (!pushed.ok) warn(`push failed, the memory commit stays local: ${failure(pushed)}`);
  });
}
