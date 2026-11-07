/**
 * The session-start hook in a cloud session (`CLAUDE_CODE_REMOTE=true`)
 * pulls `main` into the attached vault checkout and links the repositories
 * beside it to their project notes. Outside the cloud it does neither.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
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

interface CloudFixture {
  tmp: string;
  /** The session's working folder, which holds every attached repository. */
  workspace: string;
  /** The vault root inside the attached vault checkout, `<workspace>/llmos/llmOS`. */
  root: string;
  /** A code repository with a vault project folder. */
  project: string;
  /** A code repository without one. */
  unknown: string;
}

/**
 * The cloud layout: an origin, and a workspace with the vault checkout on a
 * session branch beside two code repositories. Another clone then pushes a
 * note to `main` that the hook must pull.
 */
function cloudFixture(): CloudFixture {
  const tmp = temporaryFolder();
  const origin = join(tmp, "origin.git");
  git(tmp, "init", "--bare", "--quiet", origin);
  const seed = join(tmp, "seed");
  git(tmp, "clone", "--quiet", origin, seed);
  makeVault(join(seed, "llmOS"));
  // Git keeps no empty folder, and a vault root needs `.obsidian/`.
  writeFile(join(seed, "llmOS", ".obsidian", "app.json"), "{}\n");
  writeFile(join(seed, "llmOS", "projects", "my-repo", "CONTEXT.md"), "# my-repo\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "vault");
  git(seed, "push", "--quiet", "origin", "HEAD:main");

  const workspace = join(tmp, "user");
  mkdirSync(workspace);
  const vault = join(workspace, "llmos");
  git(workspace, "clone", "--quiet", origin, vault);
  git(vault, "switch", "--quiet", "-c", "claude/session-branch");
  const project = join(workspace, "my-repo");
  const unknown = join(workspace, "unknown-repo");
  for (const repository of [project, unknown]) {
    mkdirSync(repository);
    git(repository, "init", "--quiet");
  }

  writeFile(join(seed, "llmOS", "projects", "my-repo", "notes", "new.md"), "# new\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "note");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  return { tmp, workspace, root: join(vault, "llmOS"), project, unknown };
}

function runCloud(fixture: CloudFixture, env: Record<string, string> = {}) {
  return runHook("session-start", { cwd: fixture.workspace }, fixture.tmp, {
    root: fixture.root,
    cwd: fixture.workspace,
    env: { ...GIT_ENV, CLAUDE_CODE_REMOTE: "true", ...env },
  });
}

describe("session-start in a cloud session", () => {
  test("pulls main, links each attached repository, and excludes the link", () => {
    const fixture = cloudFixture();
    const result = runCloud(fixture);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(fixture.root, "projects", "my-repo", "notes", "new.md"))).toBe(true);
    const docs = join(fixture.project, ".agents", "docs");
    expect(readlinkSync(docs)).toBe(join(fixture.root, "projects", "my-repo"));
    const excluded = readFileSync(join(fixture.project, ".git", "info", "exclude"), "utf8");
    expect(excluded.split("\n")).toContain("/.agents/docs");
    expect(result.stdout).toContain(`llmOS root: ${fixture.root}.`);
    expect(result.stdout).toContain(`${docs} links to`);
    expect(result.stdout).toContain("git push origin HEAD:main");
  });

  test("leaves a repository with no vault project folder alone, without a note", () => {
    const fixture = cloudFixture();
    const result = runCloud(fixture);
    expect(result.stdout).not.toContain(fixture.unknown);
    expect(existsSync(join(fixture.unknown, ".agents"))).toBe(false);
    expect(existsSync(join(fixture.unknown, "artifacts"))).toBe(false);
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

  test("names the linked project when the session starts inside it", () => {
    const fixture = cloudFixture();
    const result = runHook("session-start", { cwd: fixture.project }, fixture.tmp, {
      root: fixture.root,
      cwd: fixture.project,
      env: { ...GIT_ENV, CLAUDE_CODE_REMOTE: "true", CLAUDE_PROJECT_DIR: fixture.project },
    });
    const docs = join(fixture.project, ".agents", "docs");
    expect(result.stdout).toContain(`This project session reaches llmOS through ${docs}`);
  });
});

describe("session-start outside the cloud", () => {
  test("neither pulls nor links the repositories beside the vault", () => {
    const fixture = cloudFixture();
    const result = runCloud(fixture, { CLAUDE_CODE_REMOTE: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(join(fixture.project, ".agents"))).toBe(false);
    expect(existsSync(join(fixture.root, "projects", "my-repo", "notes", "new.md"))).toBe(false);
  });
});
