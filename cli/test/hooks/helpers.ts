/**
 * Run a hook event the way both harnesses do: a `bun` process with the JSON
 * payload on stdin, read back as exit code, stdout, and stderr. `HOME` and
 * `TMPDIR` point into a temporary folder, so a test never sees the machine's
 * vault config, Obsidian registry, or temp directory.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flagPath } from "../../src/dirty.ts";

export const CLI = join(import.meta.dir, "..", "..");
export const TOOLS = join(CLI, "..");
const HOT_EVENTS = new Set(["pre-tool-use", "guard-bash", "post-shell"]);
/** The source entry point of an event: the hot events have their own. */
export const entryOf = (event: string): string =>
  join(CLI, "src", "hooks", HOT_EVENTS.has(event) ? "pre-tool-use.ts" : "main.ts");
/** The committed bundle of the events that run once a session or rarely. */
export const BUNDLE = join(TOOLS, "dist", "hooks.js");
/** The committed bundle of `pre-tool-use` and `guard-bash`. */
export const HOT_BUNDLE = join(TOOLS, "dist", "pre-tool-use.js");

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** `$LLMOS_ROOT`; omitted means no vault is configured. */
  root?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Defaults to the source entry point of the event. */
  script?: string;
}

const folders: string[] = [];

/** A fresh temporary folder, resolved (macOS `/var` is a symlink to `/private/var`). */
export function temporaryFolder(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "llmos-hooks-test-")));
  folders.push(folder);
  return folder;
}

/** Remove every temporary folder made so far; register with `afterEach`. */
export function removeTemporaryFolders(): void {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
}

export function runHook(
  event: string,
  payload: unknown,
  tmp: string,
  options: RunOptions = {},
): HookResult {
  const home = join(tmp, "home");
  const scratch = join(tmp, "scratch");
  mkdirSync(home, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: scratch,
    // `bun test` runs in UTC; the hook must see the same "today" as the test.
    TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(options.root ? { LLMOS_ROOT: options.root } : {}),
    ...options.env,
  };
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      options.script ?? entryOf(event),
      event,
    ],
    stdin: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
    env,
    cwd: options.cwd ?? tmp,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The additionalContext of a PreToolUse or PostToolUse result. */
export function additionalContext(result: HookResult, eventName: string): string {
  const specific = JSON.parse(result.stdout).hookSpecificOutput;
  if (specific.hookEventName !== eventName) {
    throw new Error(`expected ${eventName}, got ${specific.hookEventName}`);
  }
  return specific.additionalContext as string;
}

/** A minimal vault: `.obsidian/` and `AGENTS.md`. */
export function makeVault(root: string): string {
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# fake vault\n");
  return root;
}

/** Write `text` to `path`, creating its folders. */
export function writeFile(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** The dirty flag of the vault at `root`, in the state folder under the test's `HOME`. */
export function dirtyFlag(tmp: string, root: string): string {
  return flagPath(root, { HOME: join(tmp, "home") });
}

/** Today's local date as `YYYY-MM-DD`. */
export function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** Run `git` in `cwd` with a fixed identity and no user config; throws on failure. */
export function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-c", "init.defaultBranch=main", ...args],
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}
