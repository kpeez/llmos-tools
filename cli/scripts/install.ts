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
 * As its last step it points `~/.local/share/llmos/current` at the new version
 * folder, so a failed install leaves `current` on the earlier version. Hermes
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
const installed = Bun.spawnSync(
  [process.execPath, "install", "--frozen-lockfile", "--production"],
  {
    cwd: join(staging, "cli"),
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (installed.exitCode !== 0) {
  rmSync(staging, { recursive: true, force: true });
  console.error("bun install failed; nothing was changed.");
  process.exit(1);
}

const previous = `${target}.old-${process.pid}`;
if (existsSync(target)) renameSync(target, previous);
renameSync(staging, target);
rmSync(previous, { recursive: true, force: true });

mkdirSync(binDir, { recursive: true });
for (const name of COMMANDS) {
  const link = join(binDir, name);
  rmSync(link, { force: true });
  symlinkSync(join(target, "cli", `bin/${name}.ts`), link);
}

for (const argv of [
  [join(binDir, "llmos"), "--help"],
  [join(binDir, "qmd"), "--version"],
]) {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    console.error(`${argv.join(" ")} failed:\n${result.stderr.toString()}`);
    process.exit(1);
  }
}
const pending = `${current}.new-${process.pid}`;
rmSync(pending, { force: true });
symlinkSync(target, pending);
renameSync(pending, current);

console.log(`installed llmOS CLI ${version} in ${target}`);
console.log(`linked ${COMMANDS.join(", ")} in ${binDir}`);
console.log(`${current} now points at ${target}`);
console.log("next: run llmos doctor");
