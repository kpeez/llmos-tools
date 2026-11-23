/**
 * Which vault project a folder belongs to. A Git repository is a vault
 * project when `<root>/projects/<repo name>` exists; the name comes from the
 * main checkout, so a worktree in `~/code/my-repo-wt-x` still maps to
 * `my-repo`. The session-start links and shared memory use the same rule.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { locate } from "./git.ts";

export interface Checkout {
  /** The worktree's top level. */
  top: string;
  /** The main checkout: the parent of the shared Git directory. */
  main: string;
  /** The shared Git directory (`git rev-parse --git-common-dir`). */
  common: string;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The vault project folder under `<root>/projects/` matching `main`, or `null`.
 * Checks the exact directory name first, then strips a leading dot and
 * lowercases (so `.dotfiles` -> `dotfiles` and `llmOS` -> `llmos`), matching
 * directory entries on disk so case-insensitive filesystems use the canonical
 * vault folder name.
 */
export function projectSlug(main: string, root: string): string | null {
  const projectsDir = join(root, "projects");
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  const name = basename(main);
  if (entries.includes(name) && isDir(join(projectsDir, name))) return name;
  const normalized = name.replace(/^\./, "").toLowerCase();
  if (normalized && entries.includes(normalized) && isDir(join(projectsDir, normalized))) {
    return normalized;
  }
  return null;
}

/** The limit of a project lookup in the CLI and the MCP server, which no hook timeout bounds. */
export const LOOKUP_GIT_MS = 5_000;

/** The Git worktree containing `path`, or `null` outside one; `timeoutMs` limits the git call. */
export function checkoutAt(path: string, timeoutMs: number): Checkout | null {
  const repo = locate(path, process.env, timeoutMs);
  if (repo === null) return null;
  const { top, commonDir: common } = repo;
  // A worktree of a bare repository has no main checkout; name it by itself.
  const main = basename(common) === ".git" ? dirname(common) : top;
  return { top, main, common };
}
