/**
 * The session-start hook in a cloud session (`CLAUDE_CODE_REMOTE=true`)
 * fast-forwards the attached vault checkout to `origin/main` and links the
 * repositories beside it to their project notes. Outside the cloud it does
 * neither.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
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
  /** The vault root, which is the attached vault checkout, `<workspace>/llmos-vault`. */
  root: string;
  /** A code repository with a vault project folder. */
  project: string;
  /** A code repository without one. */
  unknown: string;
}

/**
 * The cloud layout: an origin, and a workspace with the vault checkout on a
 * session branch beside two code repositories. The vault root is its
 * repository's root. The seed clone then pushes a note to `main` that the
 * hook must pull.
 */
function cloudFixture(): CloudFixture {
  const tmp = temporaryFolder();
  const origin = join(tmp, "origin.git");
  git(tmp, "init", "--bare", "--quiet", origin);
  const seed = join(tmp, "seed");
  git(tmp, "clone", "--quiet", origin, seed);
  makeVault(seed);
  // Git keeps no empty folder, and a vault root needs `.obsidian/`.
  writeFile(join(seed, ".obsidian", "app.json"), "{}\n");
  writeFile(join(seed, "projects", "my-repo", "CONTEXT.md"), "# my-repo\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "vault");
  git(seed, "push", "--quiet", "origin", "HEAD:main");

  const workspace = join(tmp, "user");
  mkdirSync(workspace);
  const vault = join(workspace, "llmos-vault");
  git(workspace, "clone", "--quiet", origin, vault);
  git(vault, "switch", "--quiet", "-c", "claude/session-branch");
  const project = join(workspace, "my-repo");
  const unknown = join(workspace, "unknown-repo");
  for (const repository of [project, unknown]) {
    mkdirSync(repository);
    git(repository, "init", "--quiet");
  }

  writeFile(join(seed, "projects", "my-repo", "notes", "new.md"), "# new\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "note");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  return { tmp, workspace, root: vault, project, unknown };
}

function runCloud(fixture: CloudFixture, env: Record<string, string> = {}) {
  return runHook("session-start", { cwd: fixture.workspace }, fixture.tmp, {
    root: fixture.root,
    cwd: fixture.workspace,
    env: { ...GIT_ENV, CLAUDE_CODE_REMOTE: "true", ...env },
  });
}

describe("session-start in a cloud session before the vault is attached", () => {
  test("tells the agent to attach the vault, then run the hook again", () => {
    const fixture = cloudFixture();
    const missing = join(fixture.workspace, "not-attached");
    const result = runCloud(fixture, { LLMOS_ROOT: missing, LLMOS_VAULT_REPO: "owner/vault" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("call the add_repo tool for owner/vault");
    expect(result.stdout).toContain(`clone it to ${missing}`);
    expect(result.stdout).toContain("register_repo_root");
    expect(result.stdout).toMatch(/echo '\{\}' \| bun \/\S+ session-start/);
  });

  test("says nothing without LLMOS_VAULT_REPO", () => {
    const fixture = cloudFixture();
    const result = runCloud(fixture, { LLMOS_ROOT: join(fixture.workspace, "not-attached") });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("add_repo");
  });

  test("the rerun after the attach gives the vault context", () => {
    const fixture = cloudFixture();
    const result = runCloud(fixture, { LLMOS_VAULT_REPO: "owner/vault" });
    expect(result.stdout).not.toContain("add_repo");
    expect(result.stdout).toContain(`llmOS root: ${fixture.root}.`);
  });
});

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
    git(fixture.root, "remote", "remove", "origin");
    const result = runCloud(fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("The llmOS vault pull failed:");
    expect(existsSync(join(fixture.project, ".agents", "docs"))).toBe(true);
  });

  test("leaves a checkout with its own commits as it is, with no rebase in progress", () => {
    const fixture = cloudFixture();
    // The session committed its own version of the note that main also adds.
    const note = writeFile(
      join(fixture.root, "projects", "my-repo", "notes", "new.md"),
      "# mine\n",
    );
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "--quiet", "-m", "session note");
    const head = () =>
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: fixture.root }).stdout.toString();
    const before = head();

    const result = runCloud(fixture);

    expect(result.exitCode).toBe(0);
    for (const marker of ["rebase-merge", "rebase-apply"]) {
      expect(existsSync(join(fixture.root, ".git", marker))).toBe(false);
    }
    expect(head()).toBe(before);
    expect(readFileSync(note, "utf8")).toBe("# mine\n");
    expect(result.stdout).toContain(
      "The llmOS vault pull failed: the checkout has commits that are not on origin/main",
    );
  });

  test("a session at the workspace root loads personal memory, not llmos memory", () => {
    const fixture = cloudFixture();
    writeFile(join(fixture.root, "projects", "llmos", "memory", "MEMORY.md"), "- llmos-fact\n");
    writeFile(
      join(fixture.root, "projects", "personal", "memory", "MEMORY.md"),
      "- personal-fact\n",
    );
    const result = runCloud(fixture);
    expect(result.stdout).toContain(join(fixture.root, "projects", "personal", "memory"));
    expect(result.stdout).toContain("- personal-fact");
    expect(result.stdout).not.toContain("- llmos-fact");
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

/** Fake `qmd` and `llmos` commands that log each call to a marker file. */
function fakeCommands(fixture: CloudFixture): { path: string; marker: string } {
  const bin = join(fixture.tmp, "fake-bin");
  const marker = join(fixture.tmp, "build.log");
  for (const name of ["qmd", "llmos"]) {
    const script = writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${marker}"\n`);
    chmodSync(script, 0o755);
  }
  return { path: `${bin}:/usr/bin:/bin`, marker };
}

/** The marker text once the build has run both commands, or `""` after about 3 s. */
async function awaitBuild(marker: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const text = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    if (text.includes("llmos reindex")) return text;
    await Bun.sleep(50);
  }
  return existsSync(marker) ? readFileSync(marker, "utf8") : "";
}

describe("session-start in a cloud session without a search index", () => {
  test("starts the index build in the background and says so", async () => {
    const fixture = cloudFixture();
    const fake = fakeCommands(fixture);
    const result = runCloud(fixture, { PATH: fake.path });
    expect(result.stdout).toContain("search index is building in the background");
    expect(await awaitBuild(fake.marker)).toBe(
      `qmd collection add ${fixture.root} --name llmos\n` +
        `qmd collection add ${fixture.root} --name memory --mask projects/*/memory/*.md\n` +
        "llmos reindex --no-embed\n",
    );
  });

  test("starts nothing when the index exists", async () => {
    const fixture = cloudFixture();
    const fake = fakeCommands(fixture);
    writeFile(join(fixture.tmp, "home", ".cache", "qmd", "index.sqlite"), "");
    const result = runCloud(fixture, { PATH: fake.path });
    expect(result.stdout).not.toContain("search index");
    await Bun.sleep(300);
    expect(existsSync(fake.marker)).toBe(false);
  });

  test("says the llmos CLI is missing when the commands are not on PATH", () => {
    const fixture = cloudFixture();
    const result = runCloud(fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not on PATH");
    expect(result.stdout).not.toContain("building in the background");
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
