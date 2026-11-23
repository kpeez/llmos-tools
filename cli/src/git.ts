/**
 * The one module that runs git. Every other module calls the verbs below.
 * Two Biome plugins enforce it: `../lint/git-spawn.grit` fails on a git
 * spawn anywhere else, and `../lint/git-words.grit` on `rebase`, `stash`,
 * `reset`, or `pull` in any git argument list.
 *
 * Its verbs never rewrite a work tree the user is editing and never drop a
 * commit. New commits are built without the work tree (`merge-tree
 * --write-tree`, `commit-tree`), `main` moves only with `merge --ff-only`,
 * and a push sends one checked commit ID to a named branch. There is no
 * `pull`, `rebase`, `stash`, or `reset`: a `rebase --abort` after a conflict
 * drops a commit that another writer made while HEAD was detached (the
 * `verify-memory-sync` model, `.agents/skills/verify-memory-sync/`).
 *
 * Every call has a timeout, pipes its output (hook stdout is a protocol
 * channel), never prompts for credentials, and reads paths unquoted.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

interface Result {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cwd: string, args: string[], env: Env, timeout: number): Result {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", cwd, "-c", "core.quotePath=false", ...args],
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout,
    });
    return {
      ok: result.exitCode === 0,
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      timedOut: result.exitedDueToTimeout === true,
    };
  } catch (error) {
    return { ok: false, code: null, stdout: "", stderr: String(error), timedOut: false };
  }
}

function failure(result: Result): string {
  if (result.timedOut) return "git timed out";
  // Git often names the files on the lines after the first, so keep up to three.
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    // `hint:` lines are git's advice, not the reason.
    .filter((line) => line && !line.startsWith("hint:"));
  return lines.slice(0, 3).join(" ") || "git failed";
}

function nulList(text: string): string[] {
  return text.split("\0").filter((path) => path !== "");
}

/** A git work tree: its top folder, and the environment and timeout for local calls. */
export interface Repo {
  top: string;
  env: Env;
  /** The limit of each local call, in ms. */
  local: number;
}

/** The work tree that holds `path`, or `null` outside one. */
export function locate(
  path: string,
  env: Env,
  local: number,
): (Repo & { gitDir: string; commonDir: string; prefix: string }) | null {
  const result = run(
    path,
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
      "--show-prefix",
    ],
    env,
    local,
  );
  const [top, gitDir, commonDir, prefix] = result.stdout.split("\n");
  if (!result.ok || !top || !gitDir || !commonDir) return null;
  // Git's own prefix of `path`: right also when `path` runs through a symbolic link.
  return { top, gitDir, commonDir, prefix: prefix ?? "", env, local };
}

/** A vault checkout on `main` with an `origin`, and the vault's folder relative to its top. */
export interface Checkout extends Repo {
  gitDir: string;
  commonDir: string;
  /** The vault root relative to `top`: `.` when the vault is the repository. */
  vaultRel: string;
}

const IN_PROGRESS: Record<string, string> = {
  "rebase-merge": "rebase",
  "rebase-apply": "rebase",
  MERGE_HEAD: "merge",
  CHERRY_PICK_HEAD: "cherry-pick",
};

/**
 * The checkout of the vault at `root` when it may publish to `origin/main`:
 * it has an `origin`, is on `main`, and has no rebase, merge, or cherry-pick
 * in progress. Otherwise the reason, and `paused` names the operation.
 */
export function mainCheckout(
  root: string,
  env: Env,
  local: number,
): { ok: true; checkout: Checkout } | { ok: false; reason: string; paused?: string } {
  const repo = locate(root, env, local);
  if (repo === null) return { ok: false, reason: "not in a git work tree" };
  if (!run(root, ["remote", "get-url", "origin"], env, local).ok) {
    return { ok: false, reason: "no origin" };
  }
  const branch = run(root, ["symbolic-ref", "--short", "-q", "HEAD"], env, local);
  if (branch.stdout.trim() !== "main") return { ok: false, reason: "not on main" };
  for (const [marker, paused] of Object.entries(IN_PROGRESS)) {
    try {
      statSync(join(repo.gitDir, marker));
      return { ok: false, reason: `${marker} in progress`, paused };
    } catch {}
  }
  const { prefix, ...located } = repo;
  return { ok: true, checkout: { ...located, vaultRel: prefix.replace(/\/$/, "") || "." } };
}

/** A repository-relative path as a vault-relative one, or `null` outside the vault. */
export function vaultPath(checkout: Checkout, path: string): string | null {
  if (checkout.vaultRel === ".") return path;
  const prefix = `${checkout.vaultRel}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** Files git sees as untracked under `root` (`--exclude-standard`), relative to it; `null` outside a work tree. */
export function untracked(root: string, env: Env, timeout: number): string[] | null {
  const result = run(root, ["ls-files", "-z", "--others", "--exclude-standard"], env, timeout);
  return result.ok ? nulList(result.stdout) : null;
}

/** Changed and untracked paths under `dir`, repository-relative; a rename lists both paths. */
export function changedPaths(repo: Repo, dir: string): string[] {
  const status = run(
    repo.top,
    ["--literal-pathspecs", "status", "--porcelain", "-z", "-uall", "--", dir],
    repo.env,
    repo.local,
  );
  if (!status.ok) return [];
  const entries = status.stdout.split("\0");
  const found = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    found.add(entry.slice(3));
    if (code.includes("R") || code.includes("C")) {
      const original = entries[++i] ?? "";
      if (original) found.add(original);
    }
  }
  return [...found];
}

/** `git add -A -- paths`; the reason on failure. */
export function add(repo: Repo, paths: string[]): string | null {
  const result = run(
    repo.top,
    ["--literal-pathspecs", "add", "-A", "--", ...paths],
    repo.env,
    repo.local,
  );
  return result.ok ? null : failure(result);
}

/** Whether the index differs from `HEAD` in `paths`. */
export function hasStaged(repo: Repo, paths: string[]): boolean | { error: string } {
  const result = run(
    repo.top,
    ["--literal-pathspecs", "diff", "--cached", "--quiet", "--", ...paths],
    repo.env,
    repo.local,
  );
  if (result.code === 0) return false;
  if (result.code === 1) return true;
  return { error: failure(result) };
}

/**
 * Commit only `paths`, whatever else is staged; the reason on failure. On
 * failure the paths are unstaged again, so the index is as before `add`.
 */
export function commit(repo: Repo, paths: string[], message: string): string | null {
  const committed = run(
    repo.top,
    ["--literal-pathspecs", "commit", "--quiet", "-m", message, "--", ...paths],
    repo.env,
    repo.local,
  );
  if (committed.ok) return null;
  run(
    repo.top,
    ["--literal-pathspecs", "restore", "--staged", "--", ...paths],
    repo.env,
    repo.local,
  );
  return failure(committed);
}

/** The commit ID `ref` names now, or `null`. */
export function revParse(repo: Repo, ref: string): string | null {
  const result = run(
    repo.top,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    repo.env,
    repo.local,
  );
  return result.ok ? result.stdout.trim() || null : null;
}

/** Whether `from..to` holds a commit. */
function ahead(repo: Repo, from: string, to: string): boolean {
  const result = run(repo.top, ["rev-list", "--count", `${from}..${to}`], repo.env, repo.local);
  return result.ok && (Number(result.stdout.trim()) || 0) > 0;
}

/** Whether HEAD holds a commit that `origin/main` lacks; local only, no fetch. */
export function hasUnpushed(repo: Repo): boolean {
  return ahead(repo, "origin/main", "HEAD");
}

/** `git fetch origin main` into `origin/main`: it never changes the work tree, so a timeout kill is safe. */
function fetchMain(repo: Repo, timeout: number): string | null {
  const result = run(
    repo.top,
    ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"],
    repo.env,
    timeout,
  );
  return result.ok ? null : failure(result);
}

/**
 * `git merge --ff-only target`: it keeps unrelated dirty edits and refuses
 * rather than overwrites. Returns the reason on refusal. A timeout is not
 * reported when `HEAD` already reached the target.
 */
function fastForward(repo: Repo, target: string, timeout: number): string | null {
  const merged = run(repo.top, ["merge", "--ff-only", "--quiet", target], repo.env, timeout);
  if (merged.ok) return null;
  if (merged.timedOut && revParse(repo, "HEAD") === target) return null;
  return failure(merged);
}

/**
 * Merge `origin` into `head` without the work tree (`merge-tree` computes the
 * tree, `commit-tree` makes the commit), then fast-forward HEAD to the merge.
 * A conflict or a refusal changes nothing on disk. Both inputs are fixed
 * commit IDs, so a fetch or commit by another writer meanwhile makes the
 * fast-forward or the push refuse instead of producing a merge that drops
 * that work.
 */
function mergeDiverged(
  repo: Repo,
  head: string,
  origin: string,
  message: string,
  timeout: number,
): { id: string } | { error: string } {
  const tree = run(
    repo.top,
    ["merge-tree", "--write-tree", "--name-only", origin, head],
    repo.env,
    repo.local,
  );
  const lines = tree.stdout.split("\n");
  if (!tree.ok) {
    if (tree.timedOut || !lines[0]) return { error: `merge failed: ${failure(tree)}` };
    const blank = lines.indexOf("");
    const paths = lines.slice(1, blank === -1 ? undefined : blank).slice(0, 3);
    return { error: `merge conflict in ${paths.join(", ") || "the vault"}` };
  }
  const made = run(
    repo.top,
    ["commit-tree", lines[0] ?? "", "-p", head, "-p", origin, "-m", message],
    repo.env,
    repo.local,
  );
  const id = made.stdout.trim();
  if (!made.ok || !id) return { error: `merge commit failed: ${failure(made)}` };
  const refused = fastForward(repo, id, timeout);
  return refused ? { error: refused } : { id };
}

/**
 * Paths that the commits `base..tip` change: each non-merge commit's paths,
 * and the net change, which also covers a file added inside a merge commit.
 * `null` when git fails.
 */
function changedBetween(repo: Repo, base: string, tip: string): string[] | null {
  const log = run(
    repo.top,
    ["log", "-z", "--format=", "--name-only", "--no-merges", `${base}..${tip}`],
    repo.env,
    repo.local,
  );
  const net = run(repo.top, ["diff", "-z", "--name-only", base, tip], repo.env, repo.local);
  if (!log.ok || !net.ok) return null;
  return [...new Set([...nulList(log.stdout), ...nulList(net.stdout)])];
}

/** The limits of the network and merge calls of `update` and `publish`, in ms. */
export interface Timeouts {
  fetch: number;
  merge: number;
  push: number;
}

export type Updated =
  | { done: "current" | "forwarded" }
  | { failed: "diverged" }
  | { failed: "fetch" | "read" | "fast-forward"; reason: string };

/** The two commit IDs, read once after the fetch; every later step uses these, never the names. */
function fetchAndRead(
  repo: Repo,
  timeouts: Pick<Timeouts, "fetch">,
):
  | { origin: string; tip: string; behind: boolean; ahead: boolean }
  | { failed: "fetch" | "read"; reason: string } {
  const fetchError = fetchMain(repo, timeouts.fetch);
  if (fetchError) return { failed: "fetch", reason: fetchError };
  const origin = revParse(repo, "origin/main");
  const tip = revParse(repo, "HEAD");
  if (origin === null || tip === null) {
    return { failed: "read", reason: "could not read HEAD or origin/main" };
  }
  return { origin, tip, behind: ahead(repo, tip, origin), ahead: ahead(repo, origin, tip) };
}

/**
 * Fetch `origin main` and fast-forward HEAD to it when HEAD is behind and not
 * ahead. A diverged HEAD is left as it is.
 */
export function update(repo: Repo, timeouts: Pick<Timeouts, "fetch" | "merge">): Updated {
  const read = fetchAndRead(repo, timeouts);
  if ("failed" in read) return read;
  if (!read.behind) return { done: "current" };
  if (read.ahead) return { failed: "diverged" };
  const refused = fastForward(repo, read.origin, timeouts.merge);
  return refused ? { failed: "fast-forward", reason: refused } : { done: "forwarded" };
}

export type Published =
  | { done: "current" | "forwarded" | "pushed" }
  | { failed: "check"; paths: string[] }
  | { failed: "fetch" | "read" | "fast-forward" | "merge" | "push"; reason: string };

/**
 * Bring local work to `origin/main`: fetch, then fast-forward (behind only)
 * or merge (ahead and behind), check that every unpushed commit and the net
 * change touch only `allowed` vault paths, and push that exact commit to
 * `main`. Every refusal leaves the work local, and the next run retries it
 * because HEAD is still ahead.
 */
export function publish(
  checkout: Checkout,
  options: { allowed: (vaultPath: string) => boolean; mergeMessage: string; timeouts: Timeouts },
): Published {
  const read = fetchAndRead(checkout, options.timeouts);
  if ("failed" in read) return read;
  const { origin, behind } = read;
  let { tip } = read;
  if (behind && !read.ahead) {
    const refused = fastForward(checkout, origin, options.timeouts.merge);
    return refused ? { failed: "fast-forward", reason: refused } : { done: "forwarded" };
  }
  if (!read.ahead) return { done: "current" };
  if (behind) {
    const merged = mergeDiverged(
      checkout,
      tip,
      origin,
      options.mergeMessage,
      options.timeouts.merge,
    );
    if ("error" in merged) return { failed: "merge", reason: merged.error };
    tip = merged.id;
  }
  const changed = changedBetween(checkout, origin, tip);
  if (changed === null) return { failed: "check", paths: ["(git log failed)"] };
  const others = changed.filter((path) => {
    const inVault = vaultPath(checkout, path);
    return inVault === null || !options.allowed(inVault);
  });
  if (others.length > 0) return { failed: "check", paths: others };
  // Push the checked commit itself, not whatever HEAD names by now.
  const pushed = run(
    checkout.top,
    ["push", "--quiet", "origin", `${tip}:refs/heads/main`],
    checkout.env,
    options.timeouts.push,
  );
  return pushed.ok ? { done: "pushed" } : { failed: "push", reason: failure(pushed) };
}
