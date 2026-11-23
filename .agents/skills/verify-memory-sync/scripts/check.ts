#!/usr/bin/env bun
/**
 * Model-check the shared-memory Git sync (cli/src/hooks/sync.ts and the
 * digest push in cli/src/digest.ts, both through cli/src/git.ts) with TLC.
 *
 * Runs every case in CASES and compares each result with what it expects:
 * the rules hold on the code, break on each mutant (so the check can still
 * fail), and break on the known findings, which stay findings until the code
 * changes. Every line in GUARDS must still be in its source file, so the
 * model stays tied to the code. Exits 0 only when all of that is true, 1
 * otherwise, and 2 when TLC cannot run.
 *
 * TLC: `TLA2TOOLS` (path of tla2tools.jar) and `JAVA`, else the pinned jar
 * and Java from mise, installed on first use.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SKILL = dirname(import.meta.dir);
const REPO = join(SKILL, "..", "..", "..");
const TLC_TOOL =
  "http:tla2tools[url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4";
const JAVA_TOOL = "java@temurin-25";

/** Each line the models assume, as it appears in the source file. */
const GUARDS: Record<string, string[]> = {
  "cli/src/git.ts": [
    'const origin = revParse(repo, "origin/main");',
    'const tip = revParse(repo, "HEAD");',
    '["merge", "--ff-only", "--quiet", target]',
    '["commit-tree", lines[0] ?? "", "-p", head, "-p", origin, "-m", message],',
    "const refused = fastForward(repo, id, timeout);",
    "const changed = changedBetween(checkout, origin, tip);",
    '["push", "--quiet", "origin", `${tip}:refs/heads/main`],',
  ],
  "cli/src/hooks/sync.ts": [
    "const commitError = commit(gate, paths, COMMIT_MESSAGE);",
    "const published = publish(gate, {",
    "allowed: (path) => SHARED_MEMORY_PATH.test(path),",
    'held = tryLock(joinPath(commonDir, "llmos-sync.lock.db"));',
    "held.release();",
  ],
  "cli/src/lock.ts": [
    'db.exec("BEGIN EXCLUSIVE");',
    'if ((error as { code?: unknown }).code === "SQLITE_BUSY") return null;',
    "return { release: () => db.close() };",
  ],
  "cli/src/digest.ts": [
    "const commitError = staged ? commit(checkout, inRepo, message) : null;",
    "const published = publish(checkout, {",
    "return DAILY_NOTE.test(path) || path === DIGEST_NOTE || SHARED_MEMORY_PATH.test(path);",
  ],
};

interface Case {
  label: string;
  spec: "MemorySync" | "SyncLock";
  cfg: string;
  /** Constants to set over the cfg file. */
  set?: Record<string, string>;
  /** Check only this invariant; otherwise every invariant in the cfg. */
  invariant?: string;
  expect: "holds" | "breaks";
  /** Why a break on the code is expected: a known finding, not a mutant. */
  finding?: string;
}

const CASES: Case[] = [
  { label: "sync, code", spec: "MemorySync", cfg: "MemorySync.cfg", expect: "holds" },
  {
    label: "sync, code, no lock at all",
    spec: "MemorySync",
    cfg: "MemorySync.cfg",
    set: { Mutex: "FALSE" },
    expect: "holds",
  },
  ...["NoRemoteRevert", "NoLocalLoss", "OnlyCheckedPush"].map(
    (invariant): Case => ({
      label: "sync, names mutant",
      spec: "MemorySync",
      cfg: "MemorySync.cfg",
      set: { Ids: '"names"' },
      invariant,
      expect: "breaks",
    }),
  ),
  { label: "sync + digest push, code", spec: "MemorySync", cfg: "MemorySyncDigest.cfg", expect: "holds" },
  {
    label: "sync + digest push, code, no lock at all",
    spec: "MemorySync",
    cfg: "MemorySyncDigest.cfg",
    set: { Mutex: "FALSE" },
    expect: "holds",
  },
  {
    label: "sync + digest push, rebase mutant, no private notes",
    spec: "MemorySync",
    cfg: "MemorySyncDigest.cfg",
    set: { Digest: '"rebase"', PrivateEdits: "{}" },
    invariant: "NoLocalLoss",
    expect: "breaks",
  },
  {
    label: "sync + digest push, rebase mutant",
    spec: "MemorySync",
    cfg: "MemorySyncDigest.cfg",
    set: { Digest: '"rebase"' },
    invariant: "OnlyCheckedPush",
    expect: "breaks",
  },
  { label: "lock, code, 2 runs", spec: "SyncLock", cfg: "SyncLock.cfg", expect: "holds" },
  {
    label: "lock, code, 3 runs",
    spec: "SyncLock",
    cfg: "SyncLock.cfg",
    set: { Runs: '{"s1", "s2", "s3"}' },
    expect: "holds",
  },
  {
    label: "lock, rm mutant, 2 runs",
    spec: "SyncLock",
    cfg: "SyncLock.cfg",
    set: { Lock: '"rm"' },
    expect: "breaks",
  },
  {
    label: "lock, token-file mutant, 2 runs",
    spec: "SyncLock",
    cfg: "SyncLock.cfg",
    set: { Lock: '"token"' },
    expect: "holds",
  },
  {
    label: "lock, token-file mutant, 3 runs",
    spec: "SyncLock",
    cfg: "SyncLock.cfg",
    set: { Lock: '"token"', Runs: '{"s1", "s2", "s3"}' },
    expect: "breaks",
  },
];

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function mise(args: string[]): string {
  const r = spawnSync("mise", args, {
    encoding: "utf8",
    env: { ...process.env, MISE_CEILING_PATHS: SKILL },
  });
  return r.status === 0 ? r.stdout.trim() : "";
}

function findTlc(): { jar: string; java: string } {
  const { TLA2TOOLS, JAVA } = process.env;
  if (TLA2TOOLS) {
    if (!existsSync(TLA2TOOLS)) fail(2, `TLA2TOOLS is set to ${TLA2TOOLS}, which does not exist`);
    return { jar: TLA2TOOLS, java: JAVA || "java" };
  }
  const where = (): [string, string] => [
    mise(["where", TLC_TOOL]),
    mise(["which", "java", "--tool", JAVA_TOOL]),
  ];
  let [dir, java] = where();
  if (!dir || !java) {
    const r = spawnSync("mise", ["install", JAVA_TOOL, TLC_TOOL], { stdio: "inherit" });
    if (r.status !== 0) fail(2, "mise could not install TLC and Java; or set TLA2TOOLS and JAVA");
    [dir, java] = where();
  }
  return { jar: join(dir, "tla2tools.jar"), java: JAVA || java };
}

/** The cfg text with `set` applied and, when given, only `invariant` checked. */
function configFor(c: Case): string {
  let cfg = readFileSync(join(SKILL, c.cfg), "utf8");
  for (const [name, value] of Object.entries(c.set ?? {})) {
    const line = new RegExp(`^(\\s*${name} = ).*$`, "m");
    if (!line.test(cfg)) fail(2, `${c.cfg} has no constant ${name}`);
    cfg = cfg.replace(line, `$1${value}`);
  }
  if (c.invariant) {
    cfg = cfg.replace(/^INVARIANT .*\n?/gm, "");
    cfg += `INVARIANT ${c.invariant}\n`;
  }
  return cfg;
}

/** The action names of TLC's counterexample, in order. */
function trace(out: string): string[] {
  return [...out.matchAll(/^State \d+: <(\w+)/gm)].map((m) => m[1] ?? "?");
}

async function run(tlc: { jar: string; java: string }, c: Case) {
  const work = mkdtempSync(join(tmpdir(), "verify-memory-sync-"));
  const started = performance.now();
  try {
    cpSync(join(SKILL, `${c.spec}.tla`), join(work, `${c.spec}.tla`));
    writeFileSync(join(work, "model.cfg"), configFor(c));
    const proc = Bun.spawn(
      [
        tlc.java,
        `-Djava.io.tmpdir=${work}`, // TLC unpacks its standard modules here; runs must not share it
        "-XX:+UseParallelGC",
        "-cp",
        tlc.jar,
        "tlc2.TLC",
        "-workers",
        "1",
        "-metadir",
        join(work, "states"),
        "-config",
        "model.cfg",
        `${c.spec}.tla`,
      ],
      { cwd: work, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // 0: no error; 12: an invariant is violated. Anything else is a TLC error.
    if (status !== 0 && status !== 12) {
      fail(2, `TLC failed to run ${c.label} (exit ${status}):\n${stdout}${stderr}`);
    }
    const out = stdout.trim();
    // The last count: TLC also prints progress lines with the same words.
    const states = [...out.matchAll(/([\d,]+) distinct states found/g)].at(-1)?.[1] ?? "?";
    const broken = out.match(/Invariant (\w+) is violated/)?.[1];
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    return { holds: status === 0, out, states, broken, seconds };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const missing = Object.entries(GUARDS).flatMap(([file, lines]) => {
  const source = readFileSync(join(REPO, file), "utf8");
  return lines.filter((line) => !source.includes(line)).map((line) => ({ file, line }));
});

const tlc = findTlc();
// Each TLC run is one JVM on one worker, so run a few at once.
const results: Awaited<ReturnType<typeof run>>[] = [];
const queue = CASES.map((c, i) => [c, i] as const);
const lanes = Math.max(1, Math.min(4, availableParallelism()));
await Promise.all(
  Array.from({ length: lanes }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      results[next[1]] = await run(tlc, next[0]);
    }
  }),
);
let ok = true;
for (const [i, c] of CASES.entries()) {
  const r = results[i];
  if (!r) fail(2, `no result for ${c.label}`);
  const met = (c.expect === "holds") === r.holds;
  ok &&= met;
  const what = c.invariant ?? (c.spec === "SyncLock" ? "MutualExclusion" : "all rules");
  const result = r.holds ? "holds" : `${r.broken ?? "a rule"} BREAKS`;
  console.log(
    `${met ? "ok  " : "FAIL"} ${c.label}, ${what}: ${result} (expected ${c.expect}; ${r.states} states, ${r.seconds} s)`,
  );
  if (!r.holds && met) {
    console.log(`     trace: ${trace(r.out).join(" -> ")}`);
    if (c.finding) console.log(`     ${c.finding}`);
  }
  if (!met) {
    console.log(
      r.holds
        ? c.finding
          ? "     The finding no longer reproduces: confirm the code fixed it, then expect holds here and update SKILL.md."
          : "     The mutant no longer breaks the rule: the check can no longer fail. Fix the model or the mutant."
        : `     TLC output:\n${r.out}`,
    );
  }
}
for (const { file, line } of missing) {
  console.log(`guard missing from ${file}: ${line}`);
  console.log("     The code the model describes changed: update the model first, then GUARDS.");
}
process.exit(ok && missing.length === 0 ? 0 : 1);
