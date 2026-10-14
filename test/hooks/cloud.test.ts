/**
 * The session-start hook in a cloud session (`CLAUDE_CODE_REMOTE=true`)
 * pulls the vault clone and links the session's repository to its project
 * notes. Outside the cloud it does neither.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  makeVault,
  removeTemporaryFolders,
  runHook,
  temporaryFolder,
  writeFile,
} from "./helpers.ts";

afterEach(removeTemporaryFolders);

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-c", "init.defaultBranch=main", ...args],
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

interface CloudFixture {
  tmp: string;
  /** The vault clone's root, `<clone>/llmOS`. */
  root: string;
  /** A second clone that pushes a note the hook must pull. */
  other: string;
  /** The session's code repository, named like its vault project folder. */
  project: string;
}

/** A vault repository with an origin, two clones, and a code repository. */
function cloudFixture(): CloudFixture {
  const tmp = temporaryFolder();
  const origin = join(tmp, "origin.git");
  git(tmp, "init", "--bare", "--quiet", origin);
  const clone = join(tmp, "clone");
  git(tmp, "clone", "--quiet", origin, clone);
  const root = makeVault(join(clone, "llmOS"));
  writeFile(join(root, "projects", "my-repo", "CONTEXT.md"), "# my-repo\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", "vault");
  git(clone, "push", "--quiet", "origin", "HEAD:main");
  git(clone, "branch", "--quiet", "--set-upstream-to=origin/main");
  const other = join(tmp, "other");
  git(tmp, "clone", "--quiet", origin, other);
  writeFile(join(other, "llmOS", "projects", "my-repo", "notes", "new.md"), "# new\n");
  git(other, "add", ".");
  git(other, "commit", "--quiet", "-m", "note");
  git(other, "push", "--quiet", "origin", "HEAD:main");
  const project = join(tmp, "my-repo");
  mkdirSync(project);
  git(project, "init", "--quiet");
  return { tmp, root, other, project };
}

function runCloud(fixture: CloudFixture, env: Record<string, string> = {}) {
  return runHook("session-start", { cwd: fixture.project }, fixture.tmp, {
    root: fixture.root,
    cwd: fixture.project,
    env: { ...GIT_ENV, CLAUDE_CODE_REMOTE: "true", CLAUDE_PROJECT_DIR: fixture.project, ...env },
  });
}

describe("session-start in a cloud session", () => {
  test("pulls the vault, links .agents/docs, and excludes the link from Git", () => {
    const fixture = cloudFixture();
    const result = runCloud(fixture);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(fixture.root, "projects", "my-repo", "notes", "new.md"))).toBe(true);
    const docs = join(fixture.project, ".agents", "docs");
    expect(readlinkSync(docs)).toBe(join(fixture.root, "projects", "my-repo"));
    const excluded = readFileSync(join(fixture.project, ".git", "info", "exclude"), "utf8");
    expect(excluded.split("\n")).toContain("/.agents/docs");
    expect(result.stdout).toContain(`This project session reaches llmOS through ${docs}`);
    expect(result.stdout).toContain("push to main");
  });

  test("keeps an existing .agents/docs", () => {
    const fixture = cloudFixture();
    const docs = writeFile(join(fixture.project, ".agents", "docs", "local.md"), "# local\n");
    const result = runCloud(fixture);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(docs, "utf8")).toBe("# local\n");
  });

  test("reports a failed pull and still links", () => {
    const fixture = cloudFixture();
    git(join(fixture.root, ".."), "remote", "remove", "origin");
    const result = runCloud(fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("The llmOS vault pull failed:");
    expect(existsSync(join(fixture.project, ".agents", "docs"))).toBe(true);
  });

  test("says so when the vault has no folder for the project", () => {
    const fixture = cloudFixture();
    const project = join(fixture.tmp, "unknown-repo");
    mkdirSync(project);
    const result = runHook("session-start", { cwd: project }, fixture.tmp, {
      root: fixture.root,
      cwd: project,
      env: { ...GIT_ENV, CLAUDE_CODE_REMOTE: "true", CLAUDE_PROJECT_DIR: project },
    });
    expect(result.stdout).toContain("No vault project folder");
    expect(existsSync(join(project, ".agents"))).toBe(false);
  });
});

describe("session-start outside the cloud", () => {
  test("neither pulls nor links", () => {
    const fixture = cloudFixture();
    const result = runCloud(fixture, { CLAUDE_CODE_REMOTE: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(join(fixture.project, ".agents"))).toBe(false);
    expect(existsSync(join(fixture.root, "projects", "my-repo", "notes", "new.md"))).toBe(false);
  });
});
