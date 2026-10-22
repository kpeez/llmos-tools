/**
 * Session-start setup for cloud sessions (`CLAUDE_CODE_REMOTE=true`).
 *
 * A cloud session gets the vault as an attached repository, checked out next
 * to the session's code repositories (for example `/home/user/llmos` beside
 * `/home/user/agent-toolbox`), on the session's own branch. The cloud's
 * GitHub proxy serves only attached repositories, so this is the one way a
 * cloud session can push vault notes. Each session pulls `main` into the
 * vault checkout, then links every repository beside it, and the session's
 * project, to its project notes the way `setup-llmos` links a local
 * checkout: `<repo>/.agents/docs` points at `<root>/projects/<repo name>`.
 * Locally this module does nothing.
 *
 * It never replaces an existing `.agents/docs`, and it keeps the link out of
 * Git through `.git/info/exclude`, not the repository's `.gitignore`.
 */

import { appendFileSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isDir, isFile, isSymlink, joinPath, type Payload, pathFrom, readText } from "./common.ts";

type Env = Record<string, string | undefined>;

/** The session-start hook's timeout is 10 s; the pull must end well before it. */
const PULL_TIMEOUT_MS = 6_000;
const EXCLUDE_LINE = "/.agents/docs";

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

/**
 * The code repositories to link: each repository beside the vault checkout,
 * then the session's project when it is a repository somewhere else.
 */
function repositories(vaultRepository: string, project: string | null): string[] {
  const found: string[] = [];
  const parent = dirname(vaultRepository);
  try {
    for (const name of readdirSync(parent).sort()) {
      const path = joinPath(parent, name);
      if (path !== vaultRepository && isRepository(path)) found.push(path);
    }
  } catch {}
  if (project !== null && project !== vaultRepository && isRepository(project)) {
    if (!found.includes(project)) found.push(project);
  }
  return found;
}

/** Keep the link out of `git status` without editing the repository's files. */
function exclude(repository: string): void {
  const gitDirectory = joinPath(repository, ".git");
  if (!isDir(gitDirectory)) return;
  const file = joinPath(gitDirectory, "info", "exclude");
  const existing = isFile(file) ? readText(file) : "";
  if (existing.split("\n").includes(EXCLUDE_LINE)) return;
  mkdirSync(dirname(file), { recursive: true });
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${separator}${EXCLUDE_LINE}\n`);
}

/** Link `<repository>/.agents/docs` to the vault's project folder; a note on what happened. */
function link(repository: string, root: string): string {
  const target = joinPath(root, "projects", basename(repository));
  if (!isDir(target)) return `No vault project folder ${target}; .agents/docs is not linked.`;
  const docs = joinPath(repository, ".agents", "docs");
  if (isSymlink(docs) || isDir(docs) || isFile(docs)) return "";
  mkdirSync(joinPath(repository, ".agents"), { recursive: true });
  symlinkSync(target, docs, "dir");
  exclude(repository);
  return `${docs} links to ${target}.`;
}

/**
 * Pull the vault and link the session's repositories, in a cloud session only.
 * Returns context lines for the session, or `null` outside the cloud.
 */
export function cloudSetup(data: Payload, root: string, env: Env = process.env): string | null {
  if (env.CLAUDE_CODE_REMOTE !== "true") return null;
  const vaultRepository = dirname(root);
  const notes: string[] = [];
  const pullError = pull(vaultRepository, env);
  if (pullError) notes.push(`The llmOS vault pull failed: ${pullError}`);
  const project = pathFrom(env.CLAUDE_PROJECT_DIR) ?? pathFrom(data.cwd);
  for (const repository of repositories(vaultRepository, project)) {
    try {
      const note = link(repository, root);
      if (note) notes.push(note);
    } catch (error) {
      notes.push(
        `Linking ${repository}/.agents/docs failed: ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  }
  notes.push(
    `This cloud session's vault checkout is ${vaultRepository}. Commit vault changes there, ` +
      "run git pull --rebase origin main, then git push origin HEAD:main. " +
      "Vault notes go to main, not to the session branch.",
  );
  return notes.join("\n");
}
