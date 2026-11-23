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
 * It never replaces or changes a path that exists, with one exception: a
 * dangling `.agents/docs` link (`repairDangling`) is replaced when its new
 * target folder exists, because a moved vault leaves it broken for good. A
 * dangling scratch or artifacts link stays, since its disk may be unmounted.
 * It keeps each link it makes out of Git through the `info/exclude` file that all worktrees share,
 * not the repository's `.gitignore`. A second run changes nothing.
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { LOCAL_GIT_MS } from "../hook-limits.ts";
import { MEMORY_DIR } from "../layout.ts";
import { type Checkout, checkoutAt, projectSlug } from "../project.ts";
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

interface Repository extends Checkout {
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
  /**
   * Replace a dangling link with one to the target the hook would link now,
   * when that folder exists. Only for a target that never sits on a disk that
   * may be unmounted.
   */
  repairDangling: boolean;
}

const CLAUDE_SETTINGS_REL = ".claude/settings.local.json";

const LINKS: LinkSpec[] = [
  {
    path: ".agents/docs",
    // The vault's own repository needs no link to a folder inside itself.
    target: ({ main, root, slug }) =>
      isUnder(root, main) ? null : joinPath(root, "projects", slug),
    makeTarget: false,
    repairDangling: true,
  },
  {
    path: ".agents/scratch",
    target: ({ main }) => joinPath(expandUser("~"), "agent-scratch", basename(main)),
    makeTarget: true,
    repairDangling: false,
  },
  {
    path: "artifacts",
    target: ({ main }) => joinPath(expandUser("~"), "artifacts", basename(main)),
    makeTarget: true,
    repairDangling: false,
  },
];

/** The worktree containing `path`, or `null` outside a Git worktree or vault project. */
function repositoryAt(path: string, root: string): Repository | null {
  const checkout = checkoutAt(path, LOCAL_GIT_MS);
  if (checkout === null) return null;
  const slug = projectSlug(checkout.main, root);
  if (slug === null) return null;
  return { ...checkout, root, slug };
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

/** The note for a link made or repaired, or `null` when it exists or has no target. */
function makeLink(repository: Repository, spec: LinkSpec, link: string): string | null {
  const dangling = spec.repairDangling && isSymlink(link) && !existsSync(link);
  if (!dangling && exists(link)) return null;
  const inherited = mainTarget(repository, spec.path);
  const usable = inherited !== null && !(spec.repairDangling && !existsSync(inherited));
  const target = (usable ? inherited : null) ?? spec.target(repository);
  if (target === null) return null;
  if (dangling) return repairLink(repository, spec, link, target);
  if (spec.makeTarget) mkdirSync(target, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, "dir");
  exclude(repository, spec.path);
  return `${link} links to ${target}.`;
}

/** Point the dangling `link` at `target` when that folder exists; else leave it. */
function repairLink(
  repository: Repository,
  spec: LinkSpec,
  link: string,
  target: string,
): string | null {
  if (!isDir(target)) return null;
  const temporary = `${link}.repair-${process.pid}`;
  try {
    symlinkSync(target, temporary, "dir");
    renameSync(temporary, link);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  exclude(repository, spec.path);
  return `${link} was broken; it now links to ${target}.`;
}
