/**
 * Shared project memory sync across two hosts. A bare repository is
 * `origin`, and two clones are the hosts; each clone's vault is its `vault/`
 * folder. Tests run the real hook entry point, so they see what a harness
 * sees: stdout stays clean of git output, and diagnostics land on stderr.
 */

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tryLock } from "../../src/lock.ts";
import {
  makeVault,
  removeTemporaryFolders,
  runHook,
  temporaryFolder,
  writeFile,
} from "./helpers.ts";

afterEach(removeTemporaryFolders);
// Each test runs real git across two clones and a bare origin, several hook runs deep.
setDefaultTimeout(20_000);

const MEMORY = "projects/demo/memory/MEMORY.md";

interface Host {
  repo: string;
  vault: string;
  env: Record<string, string>;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    env: {
      PATH: "/usr/bin:/bin",
      HOME: join(cwd, "..", "home"),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

/** A bare `origin` seeded with a vault holding one memory note, and a host cloned from it. */
function setup(): { tmp: string; origin: string; a: Host; clone: (name: string) => Host } {
  const tmp = temporaryFolder();
  const origin = join(tmp, "origin.git");
  git(tmp, "init", "--bare", "--initial-branch=main", origin);
  const clone = (name: string): Host => {
    const repo = join(tmp, name);
    git(tmp, "clone", "--quiet", origin, repo);
    git(repo, "checkout", "--quiet", "-B", "main");
    const vault = join(repo, "vault");
    mkdirSync(join(vault, ".obsidian"), { recursive: true }); // Git tracks no empty folder.
    return { repo, vault, env: { ...IDENTITY } };
  };
  const seed = clone("seed");
  makeVault(seed.vault);
  writeFile(join(seed.vault, MEMORY), "- seed\n");
  writeFile(join(seed.repo, "notes.txt"), "base\n");
  writeFile(join(seed.repo, "other.txt"), "base\n");
  git(seed.repo, "add", "-A");
  git(seed.repo, "commit", "--quiet", "-m", "seed");
  git(seed.repo, "push", "--quiet", "origin", "main");
  return { tmp, origin, a: clone("host-a"), clone };
}

function stop(tmp: string, host: Host, env: Record<string, string> = {}) {
  return runHook("stop", { session_id: "s" }, tmp, {
    root: host.vault,
    env: { ...host.env, ...env },
  });
}

function start(tmp: string, host: Host, env: Record<string, string> = {}) {
  return runHook("session-start", { session_id: "s" }, tmp, {
    root: host.vault,
    cwd: host.vault,
    env: { ...host.env, ...env },
  });
}

function noRebase(host: Host): boolean {
  return ["rebase-merge", "rebase-apply"].every(
    (name) => !existsSync(join(host.repo, ".git", name)),
  );
}

function originHead(origin: string): string {
  return git(origin, "rev-parse", "main");
}

test("stop commits only the memory file, pushes it, and leaves other edits alone", () => {
  const { tmp, origin, a } = setup();
  writeFile(join(a.vault, MEMORY), "- seed\n- fact\n");
  writeFile(join(a.repo, "staged.txt"), "staged\n");
  git(a.repo, "add", "staged.txt");
  writeFileSync(join(a.repo, "notes.txt"), "edited\n");

  const result = stop(tmp, a);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(originHead(origin)).toBe(git(a.repo, "rev-parse", "HEAD"));
  expect(git(a.repo, "show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual([
    "memory: sync shared project memory",
    "",
    `vault/${MEMORY}`,
  ]);
  expect(git(a.repo, "diff", "--name-only")).toBe("notes.txt");
  expect(git(a.repo, "diff", "--cached", "--name-only")).toBe("staged.txt");
  expect(readFileSync(join(a.repo, "notes.txt"), "utf8")).toBe("edited\n");
});

test("session start pulls the memory commit and prints nothing from git", () => {
  const { tmp, a, clone } = setup();
  const b = clone("host-b");
  writeFile(join(a.vault, MEMORY), "- seed\n- fact\n");
  stop(tmp, a);

  const result = start(tmp, b);
  const baseline = start(tmp, b, { LLMOS_NO_GIT_SYNC: "1" });

  expect(readFileSync(join(b.vault, MEMORY), "utf8")).toBe("- seed\n- fact\n");
  expect(result.stdout).toBe(baseline.stdout);
  expect(result.stdout).not.toContain("Updating");
});

test("a failed push leaves the commit local, and a later stop pushes it", () => {
  const { tmp, origin, a } = setup();
  const before = originHead(origin);
  const hidden = `${origin}.away`;
  renameSync(origin, hidden);
  writeFile(join(a.vault, MEMORY), "- seed\n- fact\n");

  const failed = stop(tmp, a);

  expect(failed.stderr).toContain("llmos sync:");
  expect(git(a.repo, "log", "--format=%s", "-1")).toBe("memory: sync shared project memory");
  renameSync(hidden, origin);
  expect(originHead(origin)).toBe(before);

  stop(tmp, a);

  expect(originHead(origin)).toBe(git(a.repo, "rev-parse", "HEAD"));
  expect(git(a.repo, "rev-list", "--count", "origin/main..HEAD")).toBe("0");
});

test("a merge conflict on the same memory file warns, changes nothing on disk, and keeps the commit", () => {
  const { tmp, origin, a, clone } = setup();
  const b = clone("host-b");
  writeFile(join(a.vault, MEMORY), "- from a\n");
  stop(tmp, a);
  writeFile(join(b.vault, MEMORY), "- from b\n");

  const result = stop(tmp, b);

  expect(result.stderr).toContain("merge conflict in vault/projects/demo/memory/MEMORY.md");
  expect(noRebase(b)).toBe(true);
  expect(git(b.repo, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(b.vault, MEMORY), "utf8")).toBe("- from b\n");
  expect(git(b.repo, "log", "--format=%s", "-1")).toBe("memory: sync shared project memory");
  expect(originHead(origin)).toBe(git(a.repo, "rev-parse", "HEAD"));
});

test("both hosts commit different memory files: origin has both and each start fast-forwards to it", () => {
  const { tmp, origin, a, clone } = setup();
  const b = clone("host-b");
  writeFile(join(a.vault, MEMORY), "- from a\n");
  stop(tmp, a);
  writeFile(join(b.vault, "projects/demo/memory/topic.md"), "- from b\n");

  const result = stop(tmp, b);

  expect(result.stderr).toBe("");
  expect(noRebase(b)).toBe(true);
  expect(git(origin, "log", "--format=%s", "-1")).toBe("memory: merge shared project memory");
  expect(originHead(origin)).toBe(git(b.repo, "rev-parse", "HEAD"));
  expect(readFileSync(join(b.vault, MEMORY), "utf8")).toBe("- from a\n");
  expect(readFileSync(join(b.vault, "projects/demo/memory/topic.md"), "utf8")).toBe("- from b\n");

  stop(tmp, a);
  start(tmp, a);

  expect(git(a.repo, "rev-parse", "HEAD")).toBe(originHead(origin));
  expect(readFileSync(join(a.vault, "projects/demo/memory/topic.md"), "utf8")).toBe("- from b\n");
});

/** Host A commits a change to `notes.txt` on origin; host B has the previous commit. */
function upstreamNoteChange() {
  const fixture = setup();
  const { a, clone } = fixture;
  const b = clone("host-b");
  writeFileSync(join(a.repo, "notes.txt"), "from a\n");
  git(a.repo, "commit", "--quiet", "-am", "a edits the note");
  git(a.repo, "push", "--quiet", "origin", "main");
  return { ...fixture, b };
}

test("an uncommitted edit to an unrelated file does not stop sync, and stays uncommitted", () => {
  const { tmp, origin, b } = upstreamNoteChange();
  writeFileSync(join(b.repo, "other.txt"), "mine\n");

  const started = start(tmp, b);

  expect(started.stdout).not.toContain("llmOS vault");
  expect(readFileSync(join(b.repo, "notes.txt"), "utf8")).toBe("from a\n");
  expect(git(b.repo, "status", "--porcelain")).toBe("M other.txt");

  writeFile(join(b.vault, MEMORY), "- seed\n- fact\n");
  const stopped = stop(tmp, b);

  expect(stopped.stderr).toBe("");
  expect(originHead(origin)).toBe(git(b.repo, "rev-parse", "HEAD"));
  expect(readFileSync(join(b.repo, "other.txt"), "utf8")).toBe("mine\n");
  expect(git(b.repo, "status", "--porcelain")).toBe("M other.txt");
});

test("session start refuses when an uncommitted edit overlaps an incoming change", () => {
  const { tmp, b } = upstreamNoteChange();
  writeFileSync(join(b.repo, "notes.txt"), "from b\n");

  const result = start(tmp, b);

  expect(result.stdout).toContain("The llmOS vault could not fast-forward:");
  expect(result.stdout).toContain("Shared memory may be stale.");
  expect(readFileSync(join(b.repo, "notes.txt"), "utf8")).toBe("from b\n");
  expect(git(b.repo, "status", "--porcelain")).toBe("M notes.txt");
  expect(result.stdout).not.toContain("<<<<<<<");
});

test("a write by another program during sync loses nothing", () => {
  const { tmp, b } = upstreamNoteChange();
  const hook = join(b.repo, ".git", "hooks", "post-merge");
  writeFile(
    hook,
    '#!/bin/sh\nprintf "obsidian\\n" > "$(git rev-parse --show-toplevel)/other.txt"\n',
  );
  chmodSync(hook, 0o755);
  writeFile(join(b.vault, MEMORY), "- seed\n- fact\n");

  const result = stop(tmp, b);

  expect(result.stderr).toBe("");
  expect(noRebase(b)).toBe(true);
  expect(readFileSync(join(b.repo, "other.txt"), "utf8")).toBe("obsidian\n");
});

test("a staged file stays staged after stop when origin has a new commit", () => {
  const { tmp, a, clone } = setup();
  const b = clone("host-b");
  writeFile(join(a.vault, MEMORY), "- from a\n");
  stop(tmp, a);
  writeFile(join(b.repo, "staged.txt"), "staged\n");
  git(b.repo, "add", "staged.txt");
  writeFile(join(b.vault, "projects/demo/memory/topic.md"), "- from b\n");

  stop(tmp, b);

  expect(git(b.repo, "diff", "--cached", "--name-only")).toBe("staged.txt");
});

test("session start says sync is paused while a rebase is in progress", () => {
  const { tmp, a } = setup();
  mkdirSync(join(a.repo, ".git", "rebase-merge"));

  const result = start(tmp, a);

  expect(result.stdout).toContain(
    "The llmOS vault has a rebase in progress, so shared memory sync is paused.",
  );
});

test("a memory file with a non-ASCII name is committed and pushed", () => {
  const { tmp, origin, a } = setup();
  writeFile(join(a.vault, "projects/demo/memory/café.md"), "- fact\n");

  const result = stop(tmp, a);

  expect(result.stderr).toBe("");
  expect(
    git(origin, "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", "main"),
  ).toContain("café.md");
  expect(originHead(origin)).toBe(git(a.repo, "rev-parse", "HEAD"));
});

test("the gate skips a vault without origin, off main, or with the opt-out", () => {
  const { tmp, origin, a } = setup();
  const before = originHead(origin);
  writeFile(join(a.vault, MEMORY), "- seed\n- fact\n");

  stop(tmp, a, { LLMOS_NO_GIT_SYNC: "1" });
  git(a.repo, "checkout", "--quiet", "-b", "other");
  stop(tmp, a);
  git(a.repo, "checkout", "--quiet", "main");
  git(a.repo, "remote", "remove", "origin");
  stop(tmp, a);

  expect(originHead(origin)).toBe(before);
  expect(git(a.repo, "log", "--format=%s", "-1")).toBe("seed");
});

test("a run skips while another process holds the sync lock, and runs once it ends", () => {
  const { tmp, origin, a } = setup();
  const before = originHead(origin);
  writeFile(join(a.vault, MEMORY), "- seed\n- fact\n");

  const held = tryLock(join(a.repo, ".git", "llmos-sync.lock.db"));
  stop(tmp, a);
  held?.release();
  expect(originHead(origin)).toBe(before);

  stop(tmp, a);
  expect(originHead(origin)).not.toBe(before);
});

test("a link planted at the sync lock path is refused and never followed", () => {
  const { tmp, origin, a } = setup();
  const before = originHead(origin);
  const outside = join(tmp, "planted.db");
  symlinkSync(outside, join(a.repo, ".git", "llmos-sync.lock.db"));
  writeFile(join(a.vault, MEMORY), "- seed\n- fact\n");

  const result = stop(tmp, a);

  expect(existsSync(outside)).toBe(false);
  expect(originHead(origin)).toBe(before);
  expect(result.stderr).toContain("symbolic link");
});

test("stop with no memory change and nothing ahead never touches the network", () => {
  const { tmp, origin, a } = setup();
  const hidden = `${origin}.away`;
  renameSync(origin, hidden);

  const result = stop(tmp, a);
  rmSync(hidden, { recursive: true, force: true });

  expect(result.stderr).toBe("");
});

test("stop never pushes an unpushed commit that touches more than memory", () => {
  const { tmp, origin, a } = setup();
  const before = originHead(origin);
  writeFile(join(a.vault, "projects/demo/draft.md"), "draft\n");
  git(a.repo, "add", "-A");
  git(a.repo, "commit", "--quiet", "-m", "draft note");
  writeFile(join(a.vault, MEMORY), "- seed\n- fact\n");

  const result = stop(tmp, a);

  expect(result.stderr).toContain("not pushing");
  expect(result.stderr).toContain("vault/projects/demo/draft.md");
  expect(originHead(origin)).toBe(before);
  expect(git(a.repo, "log", "--format=%s", "-1")).toBe("memory: sync shared project memory");
});

test("stop never pushes a commit that moves a note into memory", () => {
  const { tmp, origin, a } = setup();
  writeFile(join(a.vault, "projects/demo/secret.md"), "secret line one\nsecret line two\n");
  git(a.repo, "add", "-A");
  git(a.repo, "commit", "--quiet", "-m", "secret note");
  git(a.repo, "push", "--quiet", "origin", "main");
  const before = originHead(origin);
  git(a.repo, "mv", "vault/projects/demo/secret.md", "vault/projects/demo/memory/secret.md");
  git(a.repo, "commit", "--quiet", "-m", "move the note into memory");

  const result = stop(tmp, a);

  expect(result.stderr).toContain("not pushing");
  expect(result.stderr).toContain("vault/projects/demo/secret.md");
  expect(originHead(origin)).toBe(before);
});

test("a hand-made non-memory commit still blocks the push after a merge commit is made on top", () => {
  const { tmp, origin, a, clone } = setup();
  const b = clone("host-b");
  writeFile(join(b.vault, "projects/demo/memory/topic.md"), "- from b\n");
  stop(tmp, b);
  const before = originHead(origin);
  writeFile(join(a.vault, "projects/demo/draft.md"), "draft\n");
  git(a.repo, "add", "-A");
  git(a.repo, "commit", "--quiet", "-m", "draft note");
  writeFile(join(a.vault, MEMORY), "- seed\n- fact\n");

  const result = stop(tmp, a);

  expect(git(a.repo, "log", "--format=%s", "-1")).toBe("memory: merge shared project memory");
  expect(git(a.repo, "rev-list", "--merges", "--count", "origin/main..HEAD")).toBe("1");
  expect(result.stderr).toContain("not pushing");
  expect(result.stderr).toContain("vault/projects/demo/draft.md");
  expect(result.stderr).not.toContain("topic.md");
  expect(originHead(origin)).toBe(before);
});

/** A `git` on PATH that runs `action` right after the real `git <subcommand>`: a concurrent writer. */
function gitShim(tmp: string, subcommand: string, action: string): Record<string, string> {
  const bin = join(tmp, "shim-bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "git");
  writeFileSync(
    shim,
    `#!/bin/sh\n/usr/bin/git "$@"; rc=$?\nfor x in "$@"; do if [ "$x" = "${subcommand}" ]; then ${action} >/dev/null 2>&1; break; fi; done\nexit $rc\n`,
  );
  chmodSync(shim, 0o755);
  return { PATH: `${bin}:/usr/bin:/bin` };
}

/** Host A pushed one memory change and host B made another, so B has diverged. */
function diverged() {
  const fixture = setup();
  const b = fixture.clone("host-b");
  writeFile(join(fixture.a.vault, MEMORY), "- from a\n");
  stop(fixture.tmp, fixture.a);
  writeFile(join(b.vault, "projects/demo/memory/topic.md"), "- from b\n");
  return { ...fixture, b };
}

test("a rename on one side and an edit on the other side merge instead of refusing", () => {
  const { tmp, origin, a, clone } = setup();
  const body = "- one\n- two\n- three\n- four\n- five\n- six\n";
  writeFile(join(a.vault, "projects/demo/memory/topic.md"), body);
  stop(tmp, a);
  const b = clone("host-b");
  git(a.repo, "mv", "vault/projects/demo/memory/topic.md", "vault/projects/demo/memory/moved.md");
  git(a.repo, "commit", "--quiet", "-m", "move the topic");
  git(a.repo, "push", "--quiet", "origin", "main");
  writeFile(join(b.vault, "projects/demo/memory/topic.md"), `${body}- seven\n`);

  stop(tmp, b);

  expect(originHead(origin)).toBe(git(b.repo, "rev-parse", "HEAD"));
  expect(git(origin, "show", "main:vault/projects/demo/memory/moved.md")).toContain("- seven");
});

test("a fetch by another writer during the merge never reverts the new remote work", () => {
  const { tmp, origin, a, b } = diverged();
  const env = gitShim(
    tmp,
    "merge-tree",
    `sh -c 'cd ${a.repo} && printf "a second\\n" > notes.txt && /usr/bin/git commit -qam second && /usr/bin/git push -q origin main && /usr/bin/git -C ${b.repo} fetch -q origin main'`,
  );

  stop(tmp, b, env);

  expect(git(origin, "show", "main:notes.txt")).toBe("a second");
});

test("a commit by another writer during the merge is never reverted", () => {
  const { tmp, b } = diverged();
  const env = gitShim(
    tmp,
    "merge-tree",
    `sh -c 'cd ${b.repo} && printf "concurrent\\n" > notes.txt && /usr/bin/git commit -qam concurrent'`,
  );

  stop(tmp, b, env);

  expect(readFileSync(join(b.repo, "notes.txt"), "utf8")).toBe("concurrent\n");
  expect(git(b.repo, "log", "--format=%s").split("\n")).toContain("concurrent");
});

test("a commit that lands after the check is never pushed", () => {
  const { tmp, origin, a } = setup();
  writeFile(join(a.vault, MEMORY), "- seed\n- fact\n");
  const env = gitShim(
    tmp,
    "diff",
    `sh -c 'cd ${a.repo} && printf "private\\n" > private.txt && /usr/bin/git add private.txt && /usr/bin/git commit -qm private'`,
  );

  stop(tmp, a, env);

  expect(git(origin, "show", "--format=%s", "-s", "main")).toBe(
    "memory: sync shared project memory",
  );
  expect(git(origin, "ls-tree", "--name-only", "main")).not.toContain("private.txt");
});

test("a file added inside a hand-made merge commit is never pushed", () => {
  const { tmp, origin, a, clone } = setup();
  const b = clone("host-b");
  writeFile(join(a.vault, MEMORY), "- from a\n");
  stop(tmp, a);
  writeFile(join(b.vault, "projects/demo/memory/topic.md"), "- from b\n");
  git(b.repo, "add", "-A");
  git(b.repo, "commit", "--quiet", "-m", "memory: sync shared project memory");
  git(b.repo, "fetch", "--quiet", "origin");
  git(b.repo, "merge", "--quiet", "--no-ff", "--no-commit", "origin/main");
  writeFileSync(join(b.repo, "secret.txt"), "secret\n");
  git(b.repo, "add", "secret.txt");
  git(b.repo, "commit", "--quiet", "-m", "merge");

  const result = stop(tmp, b);

  expect(result.stderr).toContain("not pushing");
  expect(result.stderr).toContain("secret.txt");
  expect(git(origin, "ls-tree", "--name-only", "main")).not.toContain("secret.txt");
});
