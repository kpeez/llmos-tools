/**
 * Digest parity check: run the frozen Python `llmos-daily-activity` and the
 * TypeScript `src/digest.ts` on identical vault copies with identical `gh`
 * output and a stand-in model (`digest_stub.ts`), and require identical
 * results.
 *
 * Usage, from `tools/`:
 *   bun test/differential/digest.ts --edge [--report FILE]
 *   bun test/differential/digest.ts --vault COPY --recording FILE [--record]
 *     --date YYYY-MM-DD [--date ...] [--report FILE]
 *
 * `--edge` uses the generated vault and synthetic `gh` output of
 * `digest_edge.ts`. `--vault` takes a copy of a vault (never the live one)
 * and replays `gh` output from `--recording`; with `--record`, the Python
 * runs call the real `gh` once for each call missing from the recording and
 * add it. The TypeScript runs only ever replay.
 *
 * For each day, in order, both sides run three times: first on their own
 * copy, then again (must be a no-op), then on the other side's copy (the
 * other implementation's hash must gate the model call). After every run the
 * check requires the same exit code and stdout from both sides, byte-equal
 * vault copies, the same `gh` argument lists, and model prompts that require
 * the same references (the prompt text itself is not part of the contract).
 * It exits 1 on any difference. With `--edge` it also requires the outcomes
 * listed in `EDGE_DAYS`, so the check cannot pass on two equal failures.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { MARKER_END, MARKER_START } from "../../src/daily.ts";
import { existingHash } from "../../src/digest.ts";
import { EDGE_DAYS, writeDigestEdgeVault } from "./digest_edge.ts";

const TOOLS = resolve(dirname(import.meta.path), "../..");
const STUB = join(TOOLS, "test/differential/digest_stub.ts");
type Side = "python" | "typescript";
const SIDES: Side[] = ["python", "typescript"];

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Every file under `root` by relative path, with its SHA-256. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path)] = sha256(readFileSync(path));
    }
  };
  walk(root);
  return files;
}

/** The references each model prompt in `dir` requires, in call order. */
function promptsIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith("prompt-"))
    .sort((a, b) => Number(a.slice(7, -4)) - Number(b.slice(7, -4)))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .map((prompt) => /MUST appear in your output: (.*?)\. Summarize/s.exec(prompt)?.[1] ?? "?");
}

function ghCalls(dir: string): string[] {
  const log = join(dir, "gh.jsonl");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

function main(): number {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      edge: { type: "boolean", default: false },
      vault: { type: "string" },
      recording: { type: "string" },
      record: { type: "boolean", default: false },
      date: { type: "string", multiple: true, default: [] },
      report: { type: "string" },
    },
  });
  const edge = values.edge;
  if (edge === (values.vault !== undefined) || (!edge && !values.recording)) {
    throw new Error("usage: --edge, or --vault COPY --recording FILE --date DAY [--date ...]");
  }
  const days = edge ? EDGE_DAYS.map(([day]) => day) : values.date;
  if (days.length === 0) throw new Error("give at least one --date");

  const scratch = mkdtempSync(join(tmpdir(), "llmos-digest-parity-"));
  const source = join(scratch, "source");
  if (edge) writeDigestEdgeVault(source);
  else cpSync(resolve(values.vault as string), source, { recursive: true, verbatimSymlinks: true });

  const bin = join(scratch, "bin");
  mkdirSync(bin);
  for (const role of ["gh", "opencode"]) {
    writeFileSync(join(bin, role), `#!/bin/sh\nexec bun "${STUB}" ${role} "$@"\n`, { mode: 0o755 });
  }
  const realGh = Bun.which("gh");
  const roots: Record<Side, string> = {
    python: join(scratch, "python", "vault"),
    typescript: join(scratch, "typescript", "vault"),
  };
  for (const side of SIDES)
    cpSync(source, roots[side], { recursive: true, verbatimSymlinks: true });

  let runCount = 0;
  const run = (impl: Side, root: string, day: string): Run & { logDir: string } => {
    const logDir = join(scratch, "logs", `${++runCount}-${impl}`);
    mkdirSync(logDir, { recursive: true });
    const command =
      impl === "python"
        ? ["uv", "run", "--quiet", "llmos-daily-activity", "--root", root, "--date", day]
        : ["bun", join(TOOLS, "src/digest.ts"), "--root", root, "--date", day];
    const gh = edge ? "edge" : resolve(values.recording as string);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${bin}:${process.env.PATH}`,
      DIGEST_LOG_DIR: logDir,
      DIGEST_GH: gh,
    };
    delete env.DIGEST_REAL_GH;
    if (values.record && impl === "python") {
      if (!realGh) throw new Error("--record needs gh on PATH");
      env.DIGEST_REAL_GH = realGh;
    }
    const result = Bun.spawnSync(command, { cwd: TOOLS, env, stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      logDir,
    };
  };

  const differences: string[] = [];
  const report: Record<string, unknown>[] = [];
  const expected = new Map(EDGE_DAYS);
  for (const day of days) {
    const note = join("reviews", "daily", `${day}.md`);
    const phases: Record<string, Record<Side, Run>> = {};
    const compare = (phase: string, runs: Record<Side, Run & { logDir: string }>) => {
      phases[phase] = runs;
      const [p, t] = [runs.python, runs.typescript];
      const fail = (what: string, python: unknown, typescript: unknown) =>
        differences.push(
          `${day} ${phase}: ${what} differs\n  python:     ${JSON.stringify(python)}\n` +
            `  typescript: ${JSON.stringify(typescript)}`,
        );
      if (p.exitCode !== t.exitCode) fail("exit code", p.exitCode, t.exitCode);
      if (p.stdout !== t.stdout) fail("stdout", p.stdout, t.stdout);
      if (!isDeepStrictEqual(ghCalls(p.logDir), ghCalls(t.logDir))) {
        fail("gh calls", ghCalls(p.logDir), ghCalls(t.logDir));
      }
      const [pp, tp] = [promptsIn(p.logDir), promptsIn(t.logDir)];
      if (!isDeepStrictEqual(pp, tp)) fail("required references", pp, tp);
      const [ps, ts] = [snapshot(roots.python), snapshot(roots.typescript)];
      if (!isDeepStrictEqual(ps, ts)) {
        const paths = [...new Set([...Object.keys(ps), ...Object.keys(ts)])].filter(
          (path) => ps[path] !== ts[path],
        );
        fail("vault files", paths, paths);
      }
    };
    const before = snapshot(roots.python);
    compare("first", {
      python: run("python", roots.python, day),
      typescript: run("typescript", roots.typescript, day),
    });
    const afterFirst = snapshot(roots.python);
    const unchanged = (phase: string) => {
      for (const side of SIDES) {
        if (!isDeepStrictEqual(snapshot(roots[side]), afterFirst)) {
          differences.push(`${day} ${phase}: a repeated run changed the ${side} copy`);
        }
      }
    };
    compare("again", {
      python: run("python", roots.python, day),
      typescript: run("typescript", roots.typescript, day),
    });
    unchanged("again");
    // Each implementation on the copy the other one wrote.
    compare("crossed", {
      python: run("python", roots.typescript, day),
      typescript: run("typescript", roots.python, day),
    });
    unchanged("crossed");
    const first = phases.first?.python as Run;
    const outcome = first.exitCode === 0 ? first.stdout.trim().replace(`${day}: `, "") : "failed";
    if (edge && outcome !== expected.get(day)) {
      differences.push(`${day}: edge outcome ${outcome}, expected ${expected.get(day)}`);
    }
    for (const phase of ["again", "crossed"]) {
      const repeated = phases[phase]?.python as Run;
      const settled = /^(unchanged|silent)/.test(repeated.stdout.replace(`${day}: `, ""));
      if (first.exitCode === 0 && !settled) {
        differences.push(`${day} ${phase}: expected a no-op, got ${repeated.stdout.trim()}`);
      }
    }
    const notes = Object.fromEntries(
      SIDES.map((side) => {
        const path = join(roots[side], note);
        const text = existsSync(path) ? readFileSync(path, "utf8") : null;
        return [
          side,
          text === null
            ? null
            : {
                sha256: sha256(text),
                hash: existingHash(text),
                markers: text
                  .split("\n")
                  .filter((line) => line.includes(MARKER_START) || line.includes(MARKER_END)),
              },
        ];
      }),
    );
    report.push({
      day,
      outcome,
      changed: !isDeepStrictEqual(before, afterFirst),
      stdout: Object.fromEntries(
        Object.entries(phases).map(([phase, runs]) => [phase, runs.python.stdout.trim()]),
      ),
      ghCalls: ghCalls(join(scratch, "logs", `${runCount - 5}-python`)).length,
      notes,
    });
    console.log(
      `${day}: ${outcome}; python ${notes.python?.hash ?? "-"}; typescript ${notes.typescript?.hash ?? "-"}`,
    );
  }

  const summary = {
    source: edge ? "edge" : resolve(values.vault as string),
    recording: edge ? null : resolve(values.recording as string),
    days: report,
    differences,
  };
  if (values.report) {
    mkdirSync(dirname(resolve(values.report)), { recursive: true });
    writeFileSync(values.report, `${JSON.stringify(summary, null, 2)}\n`);
  }
  for (const difference of differences) console.error(difference);
  console.log(`${days.length} days, ${differences.length} differences`);
  rmSync(scratch, { recursive: true, force: true });
  return differences.length === 0 ? 0 : 1;
}

process.exitCode = main();
