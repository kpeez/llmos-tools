/**
 * Stand-ins for `gh` and `opencode` in the digest parity check. The check
 * puts wrapper scripts named `gh` and `opencode` first on `PATH`; each runs
 * `bun digest_stub.ts <gh|opencode> ARGS...`.
 *
 * `gh` logs its arguments to `$DIGEST_LOG_DIR/gh.jsonl` and answers from the
 * synthetic edge data (`DIGEST_GH=edge`) or from a recording
 * (`DIGEST_GH=<file>`). A recording maps the JSON-encoded argument list to
 * the call's stdout, stderr, and exit code. With `DIGEST_REAL_GH` set, a
 * call missing from the recording runs the real `gh` once and is added.
 *
 * `opencode` saves its stdin to `$DIGEST_LOG_DIR/prompt-<n>.txt` and prints
 * one final text event that links every PR and issue in the prompt's
 * activity JSON. The prompts themselves are not part of the contract and may
 * differ.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { edgeGh } from "./digest_edge.ts";

type Recorded = { stdout: string; stderr: string; exitCode: number };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`digest stub: ${name} is not set`);
  return value;
}

function gh(args: string[]): number {
  appendFileSync(join(env("DIGEST_LOG_DIR"), "gh.jsonl"), `${JSON.stringify(args)}\n`);
  const source = env("DIGEST_GH");
  let result: Recorded | undefined;
  if (source === "edge") {
    result = edgeGh(args);
  } else {
    const recording: Record<string, Recorded> = existsSync(source)
      ? JSON.parse(readFileSync(source, "utf8"))
      : {};
    const key = JSON.stringify(args);
    result = recording[key];
    const real = process.env.DIGEST_REAL_GH;
    if (result === undefined && real) {
      const run = Bun.spawnSync([real, ...args], { stdout: "pipe", stderr: "pipe" });
      result = {
        stdout: new TextDecoder("utf-8", { fatal: true }).decode(run.stdout),
        stderr: new TextDecoder().decode(run.stderr),
        exitCode: run.exitCode ?? 1,
      };
      recording[key] = result;
      writeFileSync(source, `${JSON.stringify(recording, null, 1)}\n`);
    }
    if (result === undefined) {
      process.stderr.write(`digest stub: no recording for gh ${key}\n`);
      return 97;
    }
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode;
}

// The activity JSON follows this text in both prompts.
const BEFORE_JSON = "Output only the sections.\n\n";

type Grouped = Record<
  string,
  { repos: Record<string, Record<string, { number: unknown; url: unknown }[]>> }
>;

/**
 * Every PR and issue in the prompt's activity JSON as `[#N](url)`, sorted by
 * repository and number. Both prompts carry the same JSON (apart from the
 * opened-PR difference), so both sides get the same prose, and it meets both
 * checks: Python's `#N` and TypeScript's link with repository and number.
 */
function citations(prompt: string): string[] {
  const start = prompt.indexOf(BEFORE_JSON);
  if (start === -1) throw new Error("digest stub: no activity JSON in the prompt");
  const grouped = JSON.parse(prompt.slice(start + BEFORE_JSON.length)) as Grouped;
  const refs = new Map<string, string>();
  for (const bucket of Object.values(grouped)) {
    for (const [repo, kinds] of Object.entries(bucket.repos)) {
      for (const [kind, items] of Object.entries(kinds)) {
        if (kind === "commits") continue;
        for (const item of items) {
          refs.set(`${repo}#${item.number}`, `[#${item.number}](${item.url})`);
        }
      }
    }
  }
  return [...refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, link]) => link);
}

async function opencode(): Promise<number> {
  const prompt = new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
  const dir = env("DIGEST_LOG_DIR");
  const count = readdirSync(dir).filter((name) => name.startsWith("prompt-")).length;
  writeFileSync(join(dir, `prompt-${count + 1}.txt`), prompt);
  const text = new TextDecoder().decode(prompt);
  const prose = ["### Stub summary", "", `- References: ${citations(text).join(", ")}.`].join("\n");
  const events = [
    { type: "step_start" },
    { type: "text", part: { type: "text", text: prose } },
    { type: "step_finish" },
  ];
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return 0;
}

const [role, ...args] = Bun.argv.slice(2);
if (role === "gh") process.exitCode = gh(args);
else if (role === "opencode") process.exitCode = await opencode();
else throw new Error(`digest stub: unknown role ${role}`);
