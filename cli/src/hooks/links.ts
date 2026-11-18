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

import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { MEMORY_DIR } from "../layout.ts";
import {
  expandUser,
  isDict,
  isDir,
  isFile,
  isSymlink,
  isUnder,
  joinPath,
  readText,
} from "./common.ts";

interface Repository {
  /** The worktree's top level, where the links go. */
  top: string;
  /** The main checkout: the parent of the shared Git directory. */
  main: string;
  /** The shared Git directory (`git rev-parse --git-common-dir`). */
  common: string;
  root: string;
  /** The matching folder name under `<root>/projects/`. */
  slug: string;
}

interface LinkSpec {
  /** The link's path, relative to the worktree's top level. */
  path: string;
  /** The default target, or `null` to make no link. */
  target: (repository: Repository) => string | null;
  /** Create the target folder when it is missing. */
  makeTarget: boolean;
}

const CLAUDE_SETTINGS_REL = ".claude/settings.local.json";

const LINKS: LinkSpec[] = [
  {
    path: ".agents/docs",
    // The vault's own repository needs no link to a folder inside itself.
    target: ({ main, root, slug }) =>
      isUnder(root, main) ? null : joinPath(root, "projects", slug),
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

/**
 * The vault project folder under `<root>/projects/` matching `main`, or `null`.
 * Checks the exact directory name first, then strips a leading dot and
 * lowercases (so `.dotfiles` -> `dotfiles` and `llmOS` -> `llmos`), matching
 * directory entries on disk so case-insensitive filesystems use the canonical
 * vault folder name.
 */
export function projectSlug(main: string, root: string): string | null {
  const projectsDir = joinPath(root, "projects");
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  const name = basename(main);
  if (entries.includes(name) && isDir(joinPath(projectsDir, name))) return name;
  const normalized = name.replace(/^\./, "").toLowerCase();
  if (normalized && entries.includes(normalized) && isDir(joinPath(projectsDir, normalized))) {
    return normalized;
  }
  return null;
}

/** The worktree containing `path`, or `null` outside a Git worktree or vault project. */
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
  const slug = projectSlug(main, root);
  if (slug === null) return null;
  return { top, main, common, root, slug };
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

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!exists(path)) return {};
  if (isSymlink(path) || !isFile(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readText(path));
    return isDict(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether `<main>/.claude/settings.local.json` already points `autoMemoryDirectory`
 * at `<root>/projects/<slug>/memory` before `linkAgentDirs` runs.
 */
export function hasAutoMemoryDir(projectPath: string, root: string): boolean {
  const repository = repositoryAt(projectPath, root);
  if (repository === null) return false;
  const memoryDir = joinPath(root, "projects", repository.slug, MEMORY_DIR);
  const settingsPath = joinPath(repository.main, CLAUDE_SETTINGS_REL);
  if (isSymlink(settingsPath) || !isFile(settingsPath)) return false;
  try {
    const parsed: unknown = JSON.parse(readText(settingsPath));
    return isDict(parsed) && parsed.autoMemoryDirectory === memoryDir;
  } catch {
    return false;
  }
}

function provisionMemory(repository: Repository): void {
  const memoryDir = joinPath(repository.root, "projects", repository.slug, MEMORY_DIR);
  mkdirSync(memoryDir, { recursive: true });
  const settingsPath = joinPath(repository.main, CLAUDE_SETTINGS_REL);
  if (isSymlink(dirname(settingsPath))) return;
  const existing = readJsonObject(settingsPath);
  if (existing === null) return;
  if (existing.autoMemoryDirectory !== memoryDir) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ ...existing, autoMemoryDirectory: memoryDir }, null, 2)}\n`,
    );
  }
  exclude(repository, CLAUDE_SETTINGS_REL);
}

/**
 * Make the missing links of the worktree containing `path` and provision shared
 * project memory (`projects/<slug>/memory` and `.claude/settings.local.json`).
 * Returns one note per link made or failed; none when the repository is not a
 * vault project or has every link already. A failed step never stops the rest.
 */
export function linkAgentDirs(path: string, root: string): string[] {
  let repository: Repository | null;
  try {
    repository = repositoryAt(path, root);
    if (repository === null) return [];
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
  try {
    provisionMemory(repository);
  } catch (error) {
    notes.push(`Provisioning shared memory for ${repository.main} failed: ${message(error)}`);
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
