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
 *
 * One difference is intended. Python hides an opened PR when a PR with the
 * same number merged that day in any repository; TypeScript hides only the
 * PR that itself merged (same repository and number). On a day where `gh`
 * returns such a PR, the check requires the TypeScript prompt to list it and
 * the Python prompt not to, and then allows that day's note (block and
 * hash) to differ. Both sides must still agree on everything else and be
 * no-ops on a repeated run; the crossed runs are skipped, because each side
 * correctly sees the other's hash as stale.
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
import { EDGE_DAYS, edgeGh, writeDigestEdgeVault } from "./digest_edge.ts";

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

type Pr = { number?: unknown; url?: unknown; repository?: { nameWithOwner?: unknown } };

/**
 * The URLs of the PRs that only the TypeScript digest lists as opened, from
 * the `gh` calls a run made and the stdout `answer` gives for each call:
 * opened PRs that share a number with a merged PR of another repository.
 */
function openedOnlyInTypescript(
  calls: string[],
  answer: (call: string) => string | null,
): string[] {
  const prs = (qualifier: string): Pr[] => {
    const call = calls.find((text) => {
      const args = JSON.parse(text) as string[];
      return args[0] === "search" && args[1] === "prs" && args.includes(qualifier);
    });
    const stdout = call === undefined ? null : answer(call);
    return stdout === null ? [] : (JSON.parse(stdout) as Pr[]);
  };
  const merged = prs("--merged-at");
  const key = (pr: Pr) => JSON.stringify([pr.repository?.nameWithOwner, pr.number]);
  const mergedKeys = new Set(merged.map(key));
  const mergedNumbers = new Set(merged.map((pr) => pr.number));
  return prs("--created")
    .filter((pr) => mergedNumbers.has(pr.number) && !mergedKeys.has(key(pr)))
    .map((pr) => String(pr.url));
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

  /** The stdout the stub gave for one logged `gh` call; null when the call failed. */
  const answer = (call: string): string | null => {
    const result = edge
      ? edgeGh(JSON.parse(call) as string[])
      : (
          JSON.parse(readFileSync(resolve(values.recording as string), "utf8")) as Record<
            string,
            { stdout: string; exitCode: number } | undefined
          >
        )[call];
    return result?.exitCode === 0 ? result.stdout : null;
  };
  const promptText = (dir: string): string =>
    readdirSync(dir)
      .filter((name) => name.startsWith("prompt-"))
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n");

  const differences: string[] = [];
  const report: Record<string, unknown>[] = [];
  const expected = new Map(EDGE_DAYS);
  // Notes of earlier days that differ only by the intended difference.
  const diverged = new Set<string>();
  for (const day of days) {
    const note = join("reviews", "daily", `${day}.md`);
    const phases: Record<string, Record<Side, Run>> = {};
    // Opened PRs only TypeScript lists today; when there are any, today's note may differ.
    let intended: string[] = [];
    const fail = (phase: string, what: string, python: unknown, typescript: unknown) =>
      differences.push(
        `${day} ${phase}: ${what} differs\n  python:     ${JSON.stringify(python)}\n` +
          `  typescript: ${JSON.stringify(typescript)}`,
      );
    const compare = (phase: string, runs: Record<Side, Run & { logDir: string }>) => {
      phases[phase] = runs;
      const [p, t] = [runs.python, runs.typescript];
      if (p.exitCode !== t.exitCode) fail(phase, "exit code", p.exitCode, t.exitCode);
      // A note that already holds the Python hash for such a day is current for
      // Python and stale for TypeScript, which then regenerates it.
      const staleForTypescript =
        intended.length > 0 &&
        p.stdout === `${day}: unchanged (hash match, no model call)\n` &&
        t.stdout === `${day}: updated\n`;
      if (p.stdout !== t.stdout && !staleForTypescript) fail(phase, "stdout", p.stdout, t.stdout);
      if (!isDeepStrictEqual(ghCalls(p.logDir), ghCalls(t.logDir))) {
        fail(phase, "gh calls", ghCalls(p.logDir), ghCalls(t.logDir));
      }
      const [pp, tp] = [promptsIn(p.logDir), promptsIn(t.logDir)];
      if (!isDeepStrictEqual(pp, tp) && !staleForTypescript) {
        fail(phase, "required references", pp, tp);
      }
      const [ps, ts] = [snapshot(roots.python), snapshot(roots.typescript)];
      const allowed = intended.length > 0 ? new Set([...diverged, note]) : diverged;
      const paths = [...new Set([...Object.keys(ps), ...Object.keys(ts)])].filter(
        (path) => ps[path] !== ts[path] && !allowed.has(path),
      );
      if (paths.length > 0) fail(phase, "vault files", paths, paths);
    };
    const before = snapshot(roots.python);
    const firstRuns = {
      python: run("python", roots.python, day),
      typescript: run("typescript", roots.typescript, day),
    };
    intended = openedOnlyInTypescript(ghCalls(firstRuns.python.logDir), answer);
    compare("first", firstRuns);
    if (intended.length > 0 && firstRuns.typescript.exitCode === 0) {
      // The difference must be exactly these PRs: listed by TypeScript, not by Python.
      const [pp, tp] = [
        promptText(firstRuns.python.logDir),
        promptText(firstRuns.typescript.logDir),
      ];
      for (const url of intended) {
        if (pp.includes(url) || !tp.includes(url)) {
          fail("first", `prompt lists the opened PR ${url}`, pp.includes(url), tp.includes(url));
        }
      }
      diverged.add(note);
    }
    const afterFirst = Object.fromEntries(SIDES.map((side) => [side, snapshot(roots[side])]));
    const unchanged = (phase: string) => {
      for (const side of SIDES) {
        if (!isDeepStrictEqual(snapshot(roots[side]), afterFirst[side])) {
          differences.push(`${day} ${phase}: a repeated run changed the ${side} copy`);
        }
      }
    };
    compare("again", {
      python: run("python", roots.python, day),
      typescript: run("typescript", roots.typescript, day),
    });
    unchanged("again");
    if (intended.length === 0) {
      // Each implementation on the copy the other one wrote.
      compare("crossed", {
        python: run("python", roots.typescript, day),
        typescript: run("typescript", roots.python, day),
      });
      unchanged("crossed");
    }
    const first = firstRuns.python;
    const outcome = first.exitCode === 0 ? first.stdout.trim().replace(`${day}: `, "") : "failed";
    if (edge && outcome !== expected.get(day)) {
      differences.push(`${day}: edge outcome ${outcome}, expected ${expected.get(day)}`);
    }
    for (const [phase, runs] of Object.entries(phases)) {
      if (phase === "first") continue;
      for (const side of SIDES) {
        const repeated = runs[side].stdout;
        const settled = /^(unchanged|silent)/.test(repeated.replace(`${day}: `, ""));
        if (first.exitCode === 0 && !settled) {
          differences.push(
            `${day} ${phase}: expected a no-op from ${side}, got ${repeated.trim()}`,
          );
        }
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
      changed: !isDeepStrictEqual(before, afterFirst.python),
      stdout: Object.fromEntries(
        Object.entries(phases).map(([phase, runs]) => [phase, runs.python.stdout.trim()]),
      ),
      ghCalls: ghCalls(firstRuns.python.logDir).length,
      openedOnlyInTypescript: intended,
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
