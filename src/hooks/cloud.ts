/**
 * Session-start setup for cloud sessions (`CLAUDE_CODE_REMOTE=true`).
 *
 * A cloud environment's setup script clones the vault repository once, and
 * the cloud reuses that clone for days. So each cloud session pulls the
 * vault, then links the session's repository to its project notes the way
 * `setup-llmos` links a local checkout: `<repo>/.agents/docs` points at
 * `<root>/projects/<repo name>`. Locally this module does nothing.
 *
 * It never replaces an existing `.agents/docs`, and it keeps the link out of
 * Git through `.git/info/exclude`, not the repository's `.gitignore`.
 */

import { appendFileSync, mkdirSync, symlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  isDir,
  isFile,
  isSymlink,
  isUnder,
  joinPath,
  type Payload,
  pathFrom,
  readText,
} from "./common.ts";

type Env = Record<string, string | undefined>;

/** The session-start hook's timeout is 10 s; the pull must end well before it. */
const PULL_TIMEOUT_MS = 6_000;
const EXCLUDE_LINE = "/.agents/docs";

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** `git pull --rebase` in the vault repository; an error message, or `null`. */
function pull(repository: string, env: Env): string | null {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repository, "pull", "--rebase", "--autostash", "--quiet"],
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: PULL_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return null;
  return firstLine(result.stderr.toString()) || `git exited with ${result.exitCode ?? "a signal"}`;
}

/** Keep the link out of `git status` without editing the repository's files. */
function exclude(project: string): void {
  const gitDirectory = joinPath(project, ".git");
  if (!isDir(gitDirectory)) return;
  const file = joinPath(gitDirectory, "info", "exclude");
  const existing = isFile(file) ? readText(file) : "";
  if (existing.split("\n").includes(EXCLUDE_LINE)) return;
  mkdirSync(dirname(file), { recursive: true });
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${separator}${EXCLUDE_LINE}\n`);
}

/** Link `<project>/.agents/docs` to the vault's project folder; a note on what happened. */
function link(project: string, root: string): string {
  const target = joinPath(root, "projects", basename(project));
  if (!isDir(target)) return `No vault project folder ${target}; .agents/docs is not linked.`;
  const docs = joinPath(project, ".agents", "docs");
  if (isSymlink(docs) || isDir(docs) || isFile(docs)) return "";
  mkdirSync(joinPath(project, ".agents"), { recursive: true });
  symlinkSync(target, docs, "dir");
  exclude(project);
  return "";
}

/**
 * Pull the vault and link the session's repository, in a cloud session only.
 * Returns context lines for the session, or `null` outside the cloud.
 */
export function cloudSetup(data: Payload, root: string, env: Env = process.env): string | null {
  if (env.CLAUDE_CODE_REMOTE !== "true") return null;
  const repository = dirname(root);
  const notes: string[] = [];
  const pullError = pull(repository, env);
  if (pullError) notes.push(`The llmOS vault pull failed: ${pullError}`);
  const project = pathFrom(env.CLAUDE_PROJECT_DIR) ?? pathFrom(data.cwd);
  if (project !== null && !isUnder(project, root)) {
    try {
      const note = link(project, root);
      if (note) notes.push(note);
    } catch (error) {
      notes.push(`Linking .agents/docs failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  notes.push(
    `This cloud session's vault clone is ${repository}. Commit vault changes there and push ` +
      "to main. When the push is rejected, run git pull --rebase, then push again.",
  );
  return notes.join("\n");
}
