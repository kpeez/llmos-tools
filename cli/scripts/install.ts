#!/usr/bin/env bun
/**
 * Install the llmOS CLI on this host (run by setup-llmos):
 *
 *   bun "<llmos-plugin-root>/cli/scripts/install.ts"
 *
 * Copies the plugin root (two folders above this script) to
 * `~/.local/share/llmos/<plugin version>/`, runs `bun install
 * --frozen-lockfile --production` in its `cli/` folder, and links `llmos` and
 * `qmd` into `~/.local/bin/`. The plugin folder itself is only read, so a
 * plugin cache is never modified.
 *
 * The CLI's `package.json` and `bun.lock` live in `cli/`, not the plugin root:
 * Claude Code installs dependencies into a plugin cache whose root holds both,
 * and the symbolic links in `node_modules/.bin/` then stop Claude Desktop from
 * copying the plugin to an SSH host.
 *
 * It smoke-tests the new copy in place. Only then does it link `llmos` and
 * `qmd` and point `~/.local/share/llmos/current` at the new version folder, so
 * a failed install leaves every entry point on the earlier version. Hermes
 * Agent links its plugin and skills through `current`.
 *
 * An existing `~/.local/bin` entry or `current` is replaced only when it is a
 * link into `~/.local/share/llmos/` (an earlier install). Any other entry
 * stops the install before anything changes.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { run } from "../src/run.ts";

/** A production install from the frozen lockfile takes under a minute; ten ends a hang. */
const BUN_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** `llmos --help` and `qmd --version` only start and print. */
const SMOKE_TIMEOUT_MS = 30_000;

const COMMANDS = ["llmos", "qmd"];
// Never copied: dependencies, and the caches of the retired Python package,
// which older checkouts may still hold.
const SKIPPED = new Set([
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".ty_cache",
]);

const source = resolve(import.meta.dir, "../..");
const home = process.env.HOME || homedir();
const dataRoot = join(home, ".local", "share", "llmos");
const binDir = join(home, ".local", "bin");
const version = (
  JSON.parse(readFileSync(join(source, ".claude-plugin", "plugin.json"), "utf8")) as {
    version: string;
  }
).version;
const target = join(dataRoot, version);
const current = join(dataRoot, "current");

function replaceable(link: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(link);
  } catch {
    return true; // Nothing there.
  }
  if (!stat.isSymbolicLink()) return false;
  const points = resolve(join(link, ".."), readlinkSync(link));
  return points.startsWith(`${dataRoot}/`);
}

const conflicts = [...COMMANDS.map((name) => join(binDir, name)), current].filter(
  (link) => !replaceable(link),
);
if (conflicts.length > 0) {
  console.error(
    `refusing to replace ${conflicts.join(", ")}: not a link to an llmOS install. ` +
      "Move or remove them (after checking what they are), then run this again.",
  );
  process.exit(1);
}
if (resolve(source) === resolve(target)) {
  console.error(`${source} is the install folder itself; run this from the plugin root instead.`);
  process.exit(1);
}

mkdirSync(dataRoot, { recursive: true });
const staging = `${target}.new-${process.pid}`;
rmSync(staging, { recursive: true, force: true });
cpSync(source, staging, {
  recursive: true,
  filter: (path) => !SKIPPED.has(basename(path)),
});
const installed = run([process.execPath, "install", "--frozen-lockfile", "--production"], {
  cwd: join(staging, "cli"),
  stdout: "inherit",
  stderr: "inherit",
  timeoutMs: BUN_INSTALL_TIMEOUT_MS,
});
if (installed.exitCode !== 0) {
  rmSync(staging, { recursive: true, force: true });
  console.error("bun install failed; nothing was changed.");
  process.exit(1);
}

const previous = `${target}.old-${process.pid}`;
if (existsSync(target)) renameSync(target, previous);
renameSync(staging, target);
rmSync(previous, { recursive: true, force: true });

for (const argv of [
  [join(target, "cli", "bin", "llmos.ts"), "--help"],
  [join(target, "cli", "bin", "qmd.ts"), "--version"],
]) {
  const result = run(argv, { stdout: "pipe", stderr: "pipe", timeoutMs: SMOKE_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    console.error(`${argv.join(" ")} failed:\n${result.stderr.toString()}`);
    process.exit(1);
  }
}
mkdirSync(binDir, { recursive: true });
for (const name of COMMANDS) {
  const link = join(binDir, name);
  rmSync(link, { force: true });
  symlinkSync(join(target, "cli", `bin/${name}.ts`), link);
}

const pending = `${current}.new-${process.pid}`;
rmSync(pending, { force: true });
symlinkSync(target, pending);
renameSync(pending, current);

console.log(`installed llmOS CLI ${version} in ${target}`);
console.log(`linked ${COMMANDS.join(", ")} in ${binDir}`);
console.log(`${current} now points at ${target}`);
console.log("next: run llmos doctor");
