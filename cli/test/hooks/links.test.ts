/**
 * The session-start hook links a vault project's agent folders in every
 * session, local or cloud, and in every worktree: the names come from the
 * main checkout, not the worktree folder.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { projectSlug } from "../../src/hooks/links.ts";
import {
  GIT_ENV,
  git,
  makeVault,
  removeTemporaryFolders,
  runHook,
  temporaryFolder,
  writeFile,
} from "./helpers.ts";

afterEach(removeTemporaryFolders);

test("a worktree gets links named from the main checkout, once", () => {
  const tmp = temporaryFolder();
  const root = makeVault(join(tmp, "vault"));
  mkdirSync(join(root, "projects", "my-repo"), { recursive: true });
  const main = join(tmp, "my-repo");
  mkdirSync(main);
  git(main, "init", "--quiet");
  writeFile(join(main, "README.md"), "# my-repo\n");
  git(main, "add", ".");
  git(main, "commit", "--quiet", "-m", "init");
  const custom = join(tmp, "custom-artifacts");
  symlinkSync(custom, join(main, "artifacts"));
  const worktree = join(tmp, "my-repo-wt-feature");
  git(main, "worktree", "add", "--quiet", worktree, "-b", "feature");

  const session = () =>
    runHook("session-start", { cwd: worktree }, tmp, { root, cwd: worktree, env: GIT_ENV });
  const first = session();
  expect(first.exitCode).toBe(0);
  const home = join(tmp, "home");
  expect({
    docs: readlinkSync(join(worktree, ".agents", "docs")),
    scratch: readlinkSync(join(worktree, ".agents", "scratch")),
    artifacts: readlinkSync(join(worktree, "artifacts")),
  }).toEqual({
    docs: join(root, "projects", "my-repo"),
    scratch: join(home, "agent-scratch", "my-repo"),
    artifacts: custom,
  });
  const excluded = readFileSync(join(main, ".git", "info", "exclude"), "utf8").split("\n");
  for (const line of ["/.agents/docs", "/.agents/scratch", "/artifacts"]) {
    expect(excluded.filter((entry) => entry === line)).toHaveLength(1);
  }
  expect(first.stdout).toContain(`${join(worktree, ".agents", "scratch")} links to`);

  const second = session();
  expect(second.stdout).not.toContain("links to");
  expect(readFileSync(join(main, ".git", "info", "exclude"), "utf8").split("\n")).toEqual(excluded);
});

test("a link that fails does not stop the links after it", () => {
  const tmp = temporaryFolder();
  const root = makeVault(join(tmp, "vault"));
  mkdirSync(join(root, "projects", "my-repo"), { recursive: true });
  const main = join(tmp, "my-repo");
  mkdirSync(main);
  git(main, "init", "--quiet");
  writeFile(join(main, ".agents"), "a tracked file\n");

  const result = runHook("session-start", { cwd: main }, tmp, { root, cwd: main, env: GIT_ENV });

  expect(result.exitCode).toBe(0);
  expect(readlinkSync(join(main, "artifacts"))).toBe(join(tmp, "home", "artifacts", "my-repo"));
  expect(result.stdout).toContain(`Linking ${join(main, ".agents", "docs")} failed`);
});

test("normalizes slugs (.dotfiles -> dotfiles, llmOS -> llmos) and provisions autoMemoryDirectory", () => {
  const tmp = temporaryFolder();
  const root = makeVault(join(tmp, "vault"));
  mkdirSync(join(root, "projects", "dotfiles"), { recursive: true });
  mkdirSync(join(root, "projects", "llmos"), { recursive: true });
  expect(projectSlug(join(tmp, ".dotfiles"), root)).toBe("dotfiles");
  expect(projectSlug(join(tmp, "llmOS"), root)).toBe("llmos");

  const dotfiles = join(tmp, ".dotfiles");
  mkdirSync(dotfiles);
  git(dotfiles, "init", "--quiet");
  writeFile(join(dotfiles, ".claude", "settings.local.json"), '{"keep": true}\n');

  const first = runHook("session-start", { cwd: dotfiles }, tmp, {
    root,
    cwd: dotfiles,
    env: GIT_ENV,
  });
  expect(first.exitCode).toBe(0);
  const memoryDir = join(root, "projects", "dotfiles", "memory");
  expect(existsSync(memoryDir)).toBe(true);
  expect(readlinkSync(join(dotfiles, ".agents", "docs"))).toBe(join(root, "projects", "dotfiles"));
  const settings = readFileSync(join(dotfiles, ".claude", "settings.local.json"), "utf8");
  expect(settings.endsWith("\n")).toBe(true);
  expect(JSON.parse(settings)).toEqual({ keep: true, autoMemoryDirectory: memoryDir });
  const excludeLines = readFileSync(join(dotfiles, ".git", "info", "exclude"), "utf8").split("\n");
  expect(excludeLines.filter((line) => line === "/.claude/settings.local.json")).toHaveLength(1);
});

test("provisions memory and settings.local.json inside the llmOS repo while skipping .agents/docs", () => {
  const tmp = temporaryFolder();
  const repo = join(tmp, "llmOS");
  const root = makeVault(join(repo, "llmOS"));
  mkdirSync(join(root, "projects", "llmos"), { recursive: true });
  git(repo, "init", "--quiet");

  const result = runHook("session-start", { cwd: repo }, tmp, { root, cwd: repo, env: GIT_ENV });
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(repo, ".agents", "docs"))).toBe(false);
  expect(existsSync(join(root, "projects", "llmos", "memory"))).toBe(true);
  expect(JSON.parse(readFileSync(join(repo, ".claude", "settings.local.json"), "utf8"))).toEqual({
    autoMemoryDirectory: join(root, "projects", "llmos", "memory"),
  });
});

test("skips provisioning settings.local.json when it is a symlink or invalid JSON", () => {
  const tmp = temporaryFolder();
  const root = makeVault(join(tmp, "vault"));
  mkdirSync(join(root, "projects", "sym"), { recursive: true });
  mkdirSync(join(root, "projects", "bad"), { recursive: true });

  const symRepo = join(tmp, "sym");
  mkdirSync(join(symRepo, ".claude"), { recursive: true });
  git(symRepo, "init", "--quiet");
  const outside = writeFile(join(tmp, "outside.json"), '{"x":1}\n');
  symlinkSync(outside, join(symRepo, ".claude", "settings.local.json"));

  const badRepo = join(tmp, "bad");
  mkdirSync(badRepo);
  git(badRepo, "init", "--quiet");
  writeFile(join(badRepo, ".claude", "settings.local.json"), "{not json\n");

  expect(
    runHook("session-start", { cwd: symRepo }, tmp, { root, cwd: symRepo, env: GIT_ENV }).exitCode,
  ).toBe(0);
  expect(
    runHook("session-start", { cwd: badRepo }, tmp, { root, cwd: badRepo, env: GIT_ENV }).exitCode,
  ).toBe(0);
  expect(readFileSync(outside, "utf8")).toBe('{"x":1}\n');
  expect(readFileSync(join(badRepo, ".claude", "settings.local.json"), "utf8")).toBe("{not json\n");
});
