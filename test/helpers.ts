/** Shared test helpers: temporary vaults, a recorded obsidian-cli, and CLI runs. */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type CliResult, type Context, runCli } from "../src/cli.ts";
import { COMMANDS } from "../src/commands.ts";
import type { ObsidianRunner } from "../src/obsidian.ts";
import { VaultModel } from "../src/vault.ts";

export const TOOLS = resolve(import.meta.dir, "..");
export const TODAY = "2026-10-07";

export const DAILY_TEMPLATE = `---
status: active
created: "{{date:YYYY-MM-DD}}"
updated: "{{date:YYYY-MM-DD}}"
categories:
  - "[[Reviews]]"
---

# {{date:YYYY-MM-DD}}

## Thoughts

## Projects

<!-- llmos-activity:start -->
<!-- llmos-activity:end -->
`;

/** A new temporary folder. */
export function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `llmos-${prefix}-`));
}

/** Write `files` (vault-relative path to text) under `root`. */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A temporary llmOS vault with the daily template and `files`. */
export function makeVault(files: Record<string, string> = {}): string {
  const root = join(scratch("vault"), "llmOS");
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFiles(root, {
    "AGENTS.md": "# Test vault\n",
    "templates/daily-note.md": DAILY_TEMPLATE,
    ...files,
  });
  return root;
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** A daily note for `day` whose activity block starts with `marker`. */
export function dailyNote(day: string, marker = "<!-- llmos-activity:start -->"): string {
  return (
    `---\nstatus: active\ncreated: "${day}"\nupdated: "${day}"\ncategories:\n  - "[[Reviews]]"\n---\n\n` +
    `# ${day}\n\n## Thoughts\n\nEarlier thought.\n\n## Projects\n\n${marker}\n` +
    "- [[projects/demo/demo|Demo]]: machine content  \n<!-- llmos-activity:end -->\n"
  );
}

export interface RecordedObsidian {
  calls: string[][];
  runner: ObsidianRunner;
}

/**
 * An obsidian-cli stand-in that records every call and does what the app
 * would: `move` renames the file and `create` expands the daily template.
 * With `notRunning`, it fails the way obsidian-cli does when the app is closed.
 */
export function recordedObsidian(root: string, notRunning = false): RecordedObsidian {
  const calls: string[][] = [];
  const runner: ObsidianRunner = (argv) => {
    calls.push(argv);
    if (notRunning) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.",
      };
    }
    const params = Object.fromEntries(
      argv.slice(2).map((arg) => [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]),
    );
    const path = params.path as string;
    if (argv[1] === "move") {
      mkdirSync(dirname(join(root, params.to as string)), { recursive: true });
      renameSync(join(root, path), join(root, params.to as string));
      return { exitCode: 0, stdout: `Moved: ${path} -> ${params.to}\n`, stderr: "" };
    }
    if (argv[1] === "create" && params.template !== undefined) {
      const template = read(root, `templates/${params.template}.md`);
      const day = path.slice(path.lastIndexOf("/") + 1, -3);
      writeFiles(root, { [path]: template.replaceAll("{{date:YYYY-MM-DD}}", day) });
      return { exitCode: 0, stdout: `Created: ${path}\n`, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected call: ${argv.join(" ")}` };
  };
  return { calls, runner };
}

/** An environment that keeps qmd and the llmOS config inside a temporary folder. */
export function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = scratch("home");
  return {
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    INDEX_PATH: join(home, ".cache", "qmd", "index.sqlite"),
    QMD_CONFIG_DIR: join(home, ".config", "qmd"),
    ...extra,
  };
}

/** Run the CLI in process against `root` with a recorded obsidian-cli. */
export function cli(
  root: string,
  argv: string[],
  options: { obsidian?: ObsidianRunner; env?: Record<string, string> } = {},
): Promise<CliResult> {
  const context: Context = {
    env: options.env ?? isolatedEnv(),
    root: () => root,
    model: (path) => VaultModel.load(path),
    today: () => TODAY,
    obsidian: options.obsidian ?? recordedObsidian(root).runner,
  };
  return runCli(argv, COMMANDS, context);
}

/** Write an executable script. */
export function executable(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}
