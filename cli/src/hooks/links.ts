/**
 * Session-start links for every checkout and worktree of a vault project.
 *
 * A repository is a vault project when `<root>/projects/<repo name>` exists;
 * other repositories are left alone. The repository name comes from the main
 * checkout, so a worktree in `~/code/my-repo-wt-x` still links to `my-repo`.
 * Each link in `LINKS` is made at the worktree's top level. When the main
 * checkout already has that path as a symlink, the worktree reuses its target,
 * so a custom target carries into each worktree.
 *
 * It never replaces or changes a path that exists, and it keeps each link it
 * makes out of Git through the `info/exclude` file that all worktrees share,
 * not the repository's `.gitignore`. A second run changes nothing.
 */

import { appendFileSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { expandUser, isDir, isFile, isUnder, joinPath, readText } from "./common.ts";

interface Repository {
  /** The worktree's top level, where the links go. */
  top: string;
  /** The main checkout: the parent of the shared Git directory. */
  main: string;
  /** The shared Git directory (`git rev-parse --git-common-dir`). */
  common: string;
  root: string;
}

interface LinkSpec {
  /** The link's path, relative to the worktree's top level. */
  path: string;
  /** The default target, or `null` to make no link. */
  target: (repository: Repository) => string | null;
  /** Create the target folder when it is missing. */
  makeTarget: boolean;
}

const LINKS: LinkSpec[] = [
  {
    path: ".agents/docs",
    // The vault's own repository needs no link to a folder inside itself.
    target: ({ main, root }) =>
      isUnder(root, main) ? null : joinPath(root, "projects", basename(main)),
    makeTarget: false,
  },
  {
    path: ".agents/scratch",
    target: ({ main }) => joinPath(expandUser("~"), "agent-scratch", basename(main)),
    makeTarget: true,
  },
  {
    path: "artifacts",
    target: ({ main }) => joinPath(expandUser("~"), "artifacts", basename(main)),
    makeTarget: true,
  },
];

/** The worktree containing `path`, or `null` outside a Git worktree. */
function repositoryAt(path: string, root: string): Repository | null {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-C",
      path,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  const [top, common] = result.stdout.toString().trim().split("\n");
  if (!top || !common) return null;
  // A worktree of a bare repository has no main checkout; name it by itself.
  const main = basename(common) === ".git" ? dirname(common) : top;
  return { top, main, common, root };
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The main checkout's symlink target for `path`, absolute, or `null`. */
function mainTarget(repository: Repository, path: string): string | null {
  if (repository.main === repository.top) return null;
  const link = joinPath(repository.main, path);
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    return resolve(dirname(link), readlinkSync(link));
  } catch {
    return null;
  }
}

/** Add `/<path>` to the shared exclude file once. */
function exclude(repository: Repository, path: string): void {
  const line = `/${path}`;
  const file = joinPath(repository.common, "info", "exclude");
  const existing = isFile(file) ? readText(file) : "";
  if (existing.split("\n").includes(line)) return;
  mkdirSync(dirname(file), { recursive: true });
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${separator}${line}\n`);
}

/**
 * Make the missing links of the worktree containing `path`. Returns one note
 * per link made or failed; none when the repository is not a vault project or
 * has every link already. A failed link never stops the links after it.
 */
export function linkAgentDirs(path: string, root: string): string[] {
  let repository: Repository | null;
  try {
    repository = repositoryAt(path, root);
    if (repository === null) return [];
    if (!isDir(joinPath(root, "projects", basename(repository.main)))) return [];
  } catch (error) {
    return [`Linking the agent folders of ${path} failed: ${message(error)}`];
  }
  const notes: string[] = [];
  for (const spec of LINKS) {
    const link = joinPath(repository.top, spec.path);
    try {
      const note = makeLink(repository, spec, link);
      if (note !== null) notes.push(note);
    } catch (error) {
      notes.push(`Linking ${link} failed: ${message(error)}`);
    }
  }
  return notes;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The note for a link made, or `null` when it exists or has no target. */
function makeLink(repository: Repository, spec: LinkSpec, link: string): string | null {
  if (exists(link)) return null;
  const target = mainTarget(repository, spec.path) ?? spec.target(repository);
  if (target === null) return null;
  if (spec.makeTarget) mkdirSync(target, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, "dir");
  exclude(repository, spec.path);
  return `${link} links to ${target}.`;
}
