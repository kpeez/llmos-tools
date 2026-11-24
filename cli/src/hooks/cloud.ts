/**
 * Session-start setup for cloud sessions (`CLAUDE_CODE_REMOTE=true`).
 *
 * A cloud session gets the vault as an attached repository, checked out next
 * to the session's code repositories (for example `/home/user/llmos-vault` beside
 * `/home/user/agent-toolbox`), on the session's own branch. The vault root
 * (`LLMOS_ROOT`) is that checkout. The cloud's
 * GitHub proxy serves only attached repositories, so this is the one way a
 * cloud session can push vault notes. Each session fast-forwards the vault
 * checkout to `origin/main` (never a rebase), then links every repository
 * beside it (`links.ts`); the session's own project is linked in every
 * session, local or cloud.
 * Locally this module does nothing.
 */

import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { locate, update } from "../git.ts";
import { MEMORY_COLLECTION, MEMORY_PATTERN, qmdLocation } from "../qmd-location.ts";
import { remainingMs, startDetached } from "../run.ts";
import { isDir, isFile, joinPath } from "./common.ts";
import { linkAgentDirs } from "./links.ts";

type Env = Record<string, string | undefined>;

const LOCAL_TIMEOUT_MS = 1_000;
/** Time left that one more repository needs: its project lookup is one local git call, which takes milliseconds. */
const LINK_RESERVE_MS = 100;
/**
 * The fetch gets the 6 s that the one `pull` had before the split into
 * fetch and fast-forward. Together with the fast-forward it stays within the
 * session-start deadline (`HOOK_TIMEOUT_MS` less `HOOK_RESERVE_MS`), which
 * leaves 1.5 s for the local calls (each takes milliseconds); a slow fetch
 * is cut by the deadline, never by the harness. `cloud.test.ts` pins both.
 */
export const UPDATE_TIMEOUTS = { fetch: 6_000, merge: 2_000 };

/**
 * Fetch `origin main` into the vault checkout and fast-forward it there
 * (git.ts `update`); an error message, or `null`. A checkout with its own
 * commits is left as it is.
 */
function pull(repository: string, env: Env): string | null {
  const repo = locate(repository, env, LOCAL_TIMEOUT_MS);
  if (repo === null) return "the vault is not a git checkout";
  const updated = update(repo, UPDATE_TIMEOUTS);
  if (!("failed" in updated)) return null;
  if (updated.failed === "diverged") {
    return "the checkout has commits that are not on origin/main, so it was left as it is";
  }
  return updated.reason;
}

function isRepository(path: string): boolean {
  return isDir(joinPath(path, ".git")) || isFile(joinPath(path, ".git"));
}

/** Each repository beside the vault checkout. */
function repositories(vaultRepository: string): string[] {
  const found: string[] = [];
  const parent = dirname(vaultRepository);
  try {
    for (const name of readdirSync(parent).sort()) {
      const path = joinPath(parent, name);
      if (path !== vaultRepository && isRepository(path)) found.push(path);
    }
  } catch {}
  return found;
}

/**
 * Start the keyword index build when the qmd index is missing: a fresh cloud
 * checkout has none, and `search` and `memory_search` need it. The build adds
 * the `llmos` and memory collections, then reindexes. The build outlives the hook, which
 * must not wait for it. Returns a context line, or `null` when the index exists.
 */
function buildIndex(root: string, env: Env): string | null {
  if (existsSync(qmdLocation(env).dbPath)) return null;
  if (!Bun.which("qmd", { PATH: env.PATH }) || !Bun.which("llmos", { PATH: env.PATH })) {
    return "The llmos CLI or qmd is not on PATH, so the vault search index is not built.";
  }
  const log = joinPath(tmpdir(), "llmos-index-build.log");
  try {
    startDetached(
      [
        "sh",
        "-c",
        'qmd collection add "$1" --name llmos && qmd collection add "$1" --name "$2" --mask "$3" && llmos reindex --no-embed',
        "sh",
        root,
        MEMORY_COLLECTION,
        MEMORY_PATTERN,
      ],
      { env, stdout: Bun.file(log), stderr: Bun.file(log) },
    );
  } catch {
    return null;
  }
  return `The vault search index is building in the background (log: ${log}). Search works in a minute or two.`;
}

/**
 * In a cloud session whose vault is not checked out yet, tell the agent to
 * attach it. The cloud's GitHub proxy authorizes a push only to a repository
 * attached to the session, and the agent can attach one itself with its
 * `add_repo` tool. `LLMOS_VAULT_REPO` (`owner/name`) names the vault repository.
 * `hooksScript` is this bundle, which the agent runs again once the vault exists.
 * Returns the context line, or `null` when the hint does not apply.
 */
export function cloudAttachHint(env: Env, hooksScript: string): string | null {
  const root = env.LLMOS_ROOT;
  const repository = env.LLMOS_VAULT_REPO;
  if (env.CLAUDE_CODE_REMOTE !== "true" || !root || !repository || existsSync(root)) return null;
  return (
    `The llmOS vault is not in this cloud session yet. Before other work, attach it: call the add_repo tool for ${repository}, ` +
    `clone it to ${root} as the tool result says, and call register_repo_root with that directory. ` +
    `Then run \`echo '{}' | bun ${hooksScript} session-start\` and treat its output as session context: ` +
    "it gives the llmOS vault rules and the project's shared memory index, and starts the search index build."
  );
}

/**
 * Pull the vault, start the index build, and link the repositories beside it, in a cloud session only.
 * Returns context lines for the session, or `null` outside the cloud.
 */
export function cloudSetup(root: string, env: Env = process.env): string | null {
  if (env.CLAUDE_CODE_REMOTE !== "true") return null;
  const notes: string[] = [];
  const pullError = pull(root, env);
  if (pullError) notes.push(`The llmOS vault pull failed: ${pullError}`);
  const siblings = repositories(root);
  for (const [index, repository] of siblings.entries()) {
    if (remainingMs() < LINK_RESERVE_MS) {
      notes.push(
        `Linking stopped at the hook deadline: ${siblings.length - index} repositories were not linked.`,
      );
      break;
    }
    notes.push(...linkAgentDirs(repository, root));
  }
  const indexNote = buildIndex(root, env);
  if (indexNote) notes.push(indexNote);
  notes.push(
    `This cloud session's vault checkout is ${root}. Before you edit vault notes, ` +
      "run git fetch origin main, then git merge --ff-only origin/main; if it refuses, stop and report why. " +
      "Commit vault changes there, then git push origin HEAD:main. " +
      "If the push is refused, run git fetch origin main, then git merge --no-edit origin/main, then push again once. " +
      "If that merge conflicts, run git merge --abort. After a conflict or a second refusal, stop and report. " +
      "Never rebase, stash, or reset the vault checkout: those can drop commits. " +
      "Vault notes go to main, not to the session branch.",
  );
  return notes.join("\n");
}
