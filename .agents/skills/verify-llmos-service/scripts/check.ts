#!/usr/bin/env bun
/**
 * Model-check how llmOS service processes start and stop, with TLC.
 *
 * Exits 0 only when every invariant holds for the code (`Lock = "kernel"`,
 * `CloseRemoves = FALSE`), each mutant breaks one (the code before the fix,
 * and each half of the fix alone), and cli/src/service.ts still has the
 * lines the model assumes and none of the lines it rules out. Exits 1
 * otherwise, and 2 when TLC cannot run.
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
const SERVICE = join(REPO, "cli", "src", "service.ts");
const TLC_TOOL =
  "http:tla2tools[url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4";
const JAVA_TOOL = "java@temurin-25";

/** Each line the model assumes, as it appears in service.ts. */
const GUARDS = [
  "let held = tryLock(paths.lock);",
  "held.release();",
  "if (await socketLive(paths.socket)) {",
  "rmSync(paths.socket, { force: true });",
  "server.close();",
];
/** The lock the start lock takes: an exclusive SQLite transaction (cli/src/lock.ts). */
const LOCK_GUARDS = ['db.exec("BEGIN EXCLUSIVE");', 'if ((error as { code?: unknown }).code === "SQLITE_BUSY") return null;'];
/** Code the model rules out: removing the lock file, or a second socket removal (in close()). */
const ABSENT = ["rmSync(paths.lock"];
const ONCE = "rmSync(paths.socket";

/** The code, then the mutants; each mutant must break an invariant. */
const VARIANTS = [
  { name: "the code", lock: "kernel", closeRemoves: "FALSE" },
  { name: "the code before the fix (pid lock file, rmSync in close)", lock: "file", closeRemoves: "TRUE" },
  { name: "the pid lock file alone", lock: "file", closeRemoves: "FALSE" },
  { name: "rmSync in close alone", lock: "kernel", closeRemoves: "TRUE" },
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

/** Run TLC on one variant; `ok` when every invariant holds. */
function check(
  tlc: { jar: string; java: string },
  variant: (typeof VARIANTS)[number],
): { ok: boolean; out: string } {
  const work = mkdtempSync(join(tmpdir(), "verify-llmos-service-"));
  try {
    cpSync(join(SKILL, "LlmosService.tla"), join(work, "LlmosService.tla"));
    const cfg = readFileSync(join(SKILL, "LlmosService.cfg"), "utf8")
      .replace(/Lock = "\w+"/, `Lock = "${variant.lock}"`)
      .replace(/CloseRemoves = \w+/, `CloseRemoves = ${variant.closeRemoves}`);
    writeFileSync(join(work, "LlmosService.cfg"), cfg);
    const r = spawnSync(
      tlc.java,
      ["-XX:+UseParallelGC", "-cp", tlc.jar, "tlc2.TLC", "-workers", "1", "-metadir", join(work, "states"),
        "-config", "LlmosService.cfg", "LlmosService.tla"],
      { cwd: work, encoding: "utf8" },
    );
    if (r.status === 0 || r.status === 12) return { ok: r.status === 0, out: r.stdout.trim() };
    fail(2, `TLC failed to run (exit ${r.status}):\n${r.stdout}${r.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const source = readFileSync(SERVICE, "utf8");
const lockSource = readFileSync(join(dirname(SERVICE), "lock.ts"), "utf8");
const problems = [
  ...LOCK_GUARDS.filter((line) => !lockSource.includes(line)).map((line) => `guard missing from cli/src/lock.ts: ${line}`),
  ...GUARDS.filter((line) => !source.includes(line)).map((line) => `guard missing from cli/src/service.ts: ${line}`),
  ...ABSENT.filter((line) => source.includes(line)).map((line) => `cli/src/service.ts has code the model rules out: ${line}`),
];
const removals = source.split(ONCE).length - 1;
if (removals !== 1) problems.push(`cli/src/service.ts has ${removals} \`${ONCE}\` calls; the model has one, before the bind`);

const tlc = findTlc();
const [code, ...mutants] = VARIANTS.map((variant) => ({ variant, ...check(tlc, variant) }));
if (!code.ok) console.log(`TLC output for the code:\n${code.out}\n`);
console.log(`Invariants on ${code.variant.name}: ${code.ok ? "hold" : "BREAK"}`);
for (const mutant of mutants) {
  const broken = mutant.out.match(/Invariant (\w+) is violated/)?.[1];
  console.log(`Invariants on ${mutant.variant.name}: ${mutant.ok ? "HOLD (the check cannot fail)" : `${broken} breaks, as expected`}`);
}
for (const problem of problems) console.log(problem);
process.exit(code.ok && mutants.every((m) => !m.ok) && problems.length === 0 ? 0 : 1);
