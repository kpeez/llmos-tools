#!/usr/bin/env bun
/**
 * Model-check the daily digest's note write with TLC.
 *
 * Exits 0 only when NoThoughtLost holds for the code (`Write = "fresh"`),
 * fails for the mutant (`Write = "stale"`, the code before the fix), and the
 * code still has the re-read that the model assumes. Exits 1 otherwise, and
 * 2 when TLC cannot run.
 *
 * TLC: `TLA2TOOLS` (path of tla2tools.jar) and `JAVA`, else the pinned jar
 * and Java from mise, installed on first use.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SKILL = dirname(import.meta.dir);
const REPO = join(SKILL, "..", "..", "..");
const DIGEST = join(REPO, "tools", "cli", "src", "digest.ts");
const TLC_TOOL =
  "http:tla2tools[url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4";
const JAVA_TOOL = "java@temurin-25";

/** Each line the model assumes, as it appears in processDay. */
const GUARDS = [
  "const text = existsSync(notePath) ? readText(notePath) : \"\";",
  "if (existsSync(notePath)) {",
  "atomicWrite(notePath, replaceBlock(readText(notePath), block));",
];

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function mise(args: string[]): string {
  const r = spawnSync("mise", args, { encoding: "utf8", env: { ...process.env, MISE_CEILING_PATHS: SKILL } });
  return r.status === 0 ? r.stdout.trim() : "";
}

function findTlc(): { jar: string; java: string } {
  const { TLA2TOOLS, JAVA } = process.env;
  if (TLA2TOOLS) {
    if (!existsSync(TLA2TOOLS)) fail(2, `TLA2TOOLS is set to ${TLA2TOOLS}, which does not exist`);
    return { jar: TLA2TOOLS, java: JAVA || "java" };
  }
  const where = () => [mise(["where", TLC_TOOL]), mise(["which", "java", "--tool", JAVA_TOOL])];
  let [dir, java] = where();
  if (!dir || !java) {
    const r = spawnSync("mise", ["install", JAVA_TOOL, TLC_TOOL], { stdio: "inherit" });
    if (r.status !== 0) fail(2, "mise could not install TLC and Java; or set TLA2TOOLS and JAVA");
    [dir, java] = where();
  }
  return { jar: join(dir, "tla2tools.jar"), java: JAVA || java };
}

/** Run TLC on the model with `Write` set to `write`; `ok` when every invariant holds. */
function check(tlc: { jar: string; java: string }, write: string): { ok: boolean; out: string } {
  const work = mkdtempSync(join(tmpdir(), "verify-daily-digest-"));
  try {
    cpSync(join(SKILL, "DailyDigest.tla"), join(work, "DailyDigest.tla"));
    const cfg = readFileSync(join(SKILL, "DailyDigest.cfg"), "utf8").replace(
      /Write = "\w+"/,
      `Write = "${write}"`,
    );
    writeFileSync(join(work, "DailyDigest.cfg"), cfg);
    const r = spawnSync(
      tlc.java,
      ["-XX:+UseParallelGC", "-cp", tlc.jar, "tlc2.TLC", "-workers", "1", "-metadir", join(work, "states"),
        "-config", "DailyDigest.cfg", "DailyDigest.tla"],
      { cwd: work, encoding: "utf8" },
    );
    if (r.status === 0 || r.status === 12) return { ok: r.status === 0, out: r.stdout.trim() };
    fail(2, `TLC failed to run (exit ${r.status}):\n${r.stdout}${r.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const source = readFileSync(DIGEST, "utf8");
const missing = GUARDS.filter((line) => !source.includes(line));
const tlc = findTlc();
const code = check(tlc, "fresh");
const mutant = check(tlc, "stale").ok;
if (!code.ok) console.log(`TLC output for the code:\n${code.out}\n`);

console.log(`NoThoughtLost on the code: ${code.ok ? "holds" : "BREAKS"}`);
console.log(`NoThoughtLost on the stale-write mutant: ${mutant ? "HOLDS (the check cannot fail)" : "breaks, as expected"}`);
for (const line of missing) console.log(`guard missing from tools/cli/src/digest.ts: ${line}`);
process.exit(code.ok && !mutant && missing.length === 0 ? 0 : 1);
