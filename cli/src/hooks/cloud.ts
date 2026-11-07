/**
 * Session-start setup for cloud sessions (`CLAUDE_CODE_REMOTE=true`).
 *
 * A cloud session gets the vault as an attached repository, checked out next
 * to the session's code repositories (for example `/home/user/llmos` beside
 * `/home/user/agent-toolbox`), on the session's own branch. The cloud's
 * GitHub proxy serves only attached repositories, so this is the one way a
 * cloud session can push vault notes. Each session pulls `main` into the
 * vault checkout, then links every repository beside it (`links.ts`); the
 * session's own project is linked in every session, local or cloud.
 * Locally this module does nothing.
 */

import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { isDir, isFile, joinPath } from "./common.ts";
import { linkAgentDirs } from "./links.ts";

type Env = Record<string, string | undefined>;

/** The session-start hook's timeout is 10 s; the pull must end well before it. */
const PULL_TIMEOUT_MS = 6_000;

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** `git pull --rebase origin main` in the vault checkout; an error message, or `null`. */
function pull(repository: string, env: Env): string | null {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repository, "pull", "--rebase", "--autostash", "--quiet", "origin", "main"],
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: PULL_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return null;
  return firstLine(result.stderr.toString()) || `git exited with ${result.exitCode ?? "a signal"}`;
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
 * Pull the vault and link the repositories beside it, in a cloud session only.
 * Returns context lines for the session, or `null` outside the cloud.
 */
export function cloudSetup(root: string, env: Env = process.env): string | null {
  if (env.CLAUDE_CODE_REMOTE !== "true") return null;
  const vaultRepository = dirname(root);
  const notes: string[] = [];
  const pullError = pull(vaultRepository, env);
  if (pullError) notes.push(`The llmOS vault pull failed: ${pullError}`);
  for (const repository of repositories(vaultRepository)) {
    notes.push(...linkAgentDirs(repository, root));
  }
  notes.push(
    `This cloud session's vault checkout is ${vaultRepository}. Commit vault changes there, ` +
      "run git pull --rebase origin main, then git push origin HEAD:main. " +
      "Vault notes go to main, not to the session branch.",
  );
  return notes.join("\n");
}
