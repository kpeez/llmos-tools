/**
 * Session-start setup for cloud sessions (`CLAUDE_CODE_REMOTE=true`).
 *
 * A cloud session gets the vault as an attached repository, checked out next
 * to the session's code repositories (for example `/home/user/llmos-vault` beside
 * `/home/user/agent-toolbox`), on the session's own branch. The vault root
 * (`LLMOS_ROOT`) is that checkout. The cloud's
 * GitHub proxy serves only attached repositories, so this is the one way a
 * cloud session can push vault notes. Each session pulls `main` into the
 * vault checkout, then links every repository beside it (`links.ts`); the
 * session's own project is linked in every session, local or cloud.
 * Locally this module does nothing.
 */

import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { MEMORY_COLLECTION, MEMORY_PATTERN, qmdLocation } from "../qmd-location.ts";
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
    const build = Bun.spawn({
      cmd: [
        "sh",
        "-c",
        'qmd collection add "$1" --name llmos && qmd collection add "$1" --name "$2" --mask "$3" && llmos reindex --no-embed',
        "sh",
        root,
        MEMORY_COLLECTION,
        MEMORY_PATTERN,
      ],
      env,
      stdin: "ignore",
      stdout: Bun.file(log),
      stderr: Bun.file(log),
      detached: true,
    });
    build.unref();
  } catch {
    return null;
  }
  return `The vault search index is building in the background (log: ${log}). Search works in a minute or two.`;
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
  for (const repository of repositories(root)) {
    notes.push(...linkAgentDirs(repository, root));
  }
  const indexNote = buildIndex(root, env);
  if (indexNote) notes.push(indexNote);
  notes.push(
    `This cloud session's vault checkout is ${root}. Commit vault changes there, ` +
      "run git pull --rebase origin main, then git push origin HEAD:main. " +
      "Vault notes go to main, not to the session branch.",
  );
  return notes.join("\n");
}
