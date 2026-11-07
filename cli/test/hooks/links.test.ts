/**
 * The session-start hook links a vault project's agent folders in every
 * session, local or cloud, and in every worktree: the names come from the
 * main checkout, not the worktree folder.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
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
