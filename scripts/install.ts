#!/usr/bin/env bun
/**
 * Install the llmOS CLI on this host (run by setup-llmos):
 *
 *   bun "<llmos-plugin-root>/scripts/install.ts"
 *
 * Copies the plugin root (this script's parent folder) to
 * `~/.local/share/llmos/<plugin version>/`, runs `bun install
 * --frozen-lockfile --production` there, and links `llmos-vault`,
 * `llmos-doctor`, `llmos-audit`, `llmos-daily-activity` (`src/digest.ts`), and
 * `qmd` into `~/.local/bin/`. The plugin
 * folder itself is only read, so a plugin cache is never modified.
 *
 * An existing `~/.local/bin` entry is replaced only when it is a link into
 * `~/.local/share/llmos/` (an earlier install) or into the retired Python
 * `llmos-vault` uv tool. Any other entry stops the install before anything
 * changes.
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

const COMMANDS = ["llmos-vault", "llmos-doctor", "llmos-audit", "llmos-daily-activity", "qmd"];
/** Entry points outside `bin/<name>.ts`. */
const ENTRY_POINTS: Record<string, string> = { "llmos-daily-activity": "src/digest.ts" };
const SKIPPED = new Set([
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".ty_cache",
]);

const source = resolve(import.meta.dir, "..");
const home = process.env.HOME || homedir();
const dataRoot = join(home, ".local", "share", "llmos");
const binDir = join(home, ".local", "bin");
const version = (
  JSON.parse(readFileSync(join(source, ".claude-plugin", "plugin.json"), "utf8")) as {
    version: string;
  }
).version;
const target = join(dataRoot, version);

function replaceable(link: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(link);
  } catch {
    return true; // Nothing there.
  }
  if (!stat.isSymbolicLink()) return false;
  const points = resolve(join(link, ".."), readlinkSync(link));
  return points.startsWith(`${dataRoot}/`) || points.includes("/uv/tools/llmos-vault/");
}

const conflicts = COMMANDS.map((name) => join(binDir, name)).filter((link) => !replaceable(link));
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
    cwd: staging,
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
  symlinkSync(join(target, ENTRY_POINTS[name] ?? `bin/${name}.ts`), link);
}

for (const argv of [
  [join(binDir, "llmos-vault"), "--help"],
  [join(binDir, "llmos-daily-activity"), "--help"],
  [join(binDir, "qmd"), "--version"],
]) {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    console.error(`${argv.join(" ")} failed:\n${result.stderr.toString()}`);
    process.exit(1);
  }
}
console.log(`installed llmOS CLI ${version} in ${target}`);
console.log(`linked ${COMMANDS.join(", ")} in ${binDir}`);
console.log("next: run llmos-doctor");
