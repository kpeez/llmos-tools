/**
 * Wall time of each hook event, as a harness pays it: one `bun` process per
 * call, payload on stdin. Prints the median of N runs (after 3 warm-ups) as
 * JSON. Point it at a COPY of a vault, never the live one: post-tool-use
 * stamps the note it is given.
 *
 *   bun test/hooks/bench.ts <vault-copy> [runs=15]
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOLS = join(import.meta.dir, "..", "..", "..");
const args = process.argv.slice(2);
const vault = args[0];
if (!vault) throw new Error("usage: bun test/hooks/bench.ts <vault-copy> [runs]");
const runs = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 15);
const note = join(vault, "projects", "llmos", "llmos.md");
// A note with an explicit `.md` reference makes the authoring check walk every note path.
const referencing = join(vault, "hook-bench-reference.md");
writeFileSync(referencing, "---\ncreated: 2026-10-07\n---\n\nSee projects/llmos/llmos.md.\n");
// Dirty flags and the heartbeat go to a scratch folder, not the machine's.
const scratch = mkdtempSync(join(tmpdir(), "llmos-hook-bench-"));

const cases: [string, unknown, string?][] = [
  ["session-start", { cwd: vault }],
  ["pre-tool-use", { tool_name: "Read", tool_input: { file_path: note } }],
  ["pre-tool-use", { tool_name: "Edit", tool_input: { file_path: note } }, "write"],
  [
    "pre-tool-use",
    { tool_name: "Bash", tool_input: { command: "git status" }, cwd: vault },
    "Bash, fast path",
  ],
  [
    "pre-tool-use",
    { tool_name: "Bash", tool_input: { command: "mv a.txt b.txt" }, cwd: vault },
    "Bash, mv, not a note",
  ],
  [
    "pre-tool-use",
    { tool_name: "Bash", tool_input: { command: `mv ${note} x.md` }, cwd: vault },
    "Bash, mv a note: deny",
  ],
  ["post-tool-use", { session_id: "bench", tool_input: { file_path: note } }, "no .md reference"],
  [
    "post-tool-use",
    { session_id: "bench", tool_input: { file_path: referencing } },
    ".md reference: walks the vault",
  ],
  ["stop", { session_id: "bench-clean" }, "no dirty flag"],
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function time(cmd: string[], payload: unknown): number {
  const env = {
    ...process.env,
    LLMOS_ROOT: vault,
    CLAUDECODE: "1",
    TMPDIR: scratch,
    XDG_STATE_HOME: scratch,
  };
  const stdin = Buffer.from(JSON.stringify(payload));
  const samples: number[] = [];
  for (let i = 0; i < runs + 3; i++) {
    const start = performance.now();
    const result = Bun.spawnSync({
      cmd,
      stdin,
      env,
      cwd: vault as string,
      stdout: "ignore",
      stderr: "ignore",
      timeout: 10_000,
    });
    const elapsed = performance.now() - start;
    if (result.exitCode !== 0 && result.exitCode !== 2) {
      throw new Error(`${cmd.join(" ")} exited ${result.exitCode}`);
    }
    if (i >= 3) samples.push(elapsed);
  }
  return Math.round(median(samples) * 10) / 10;
}

const rows = cases.map(([event, payload, label]) => {
  const bun = time(
    [
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      join(
        TOOLS,
        "dist",
        event === "pre-tool-use" || event === "guard-bash" ? "pre-tool-use.js" : "hooks.js",
      ),
      event,
    ],
    payload,
  );
  return { event, case: label ?? "", bunMs: bun };
});
console.log(JSON.stringify({ runs, bun: Bun.version, vault, rows }, null, 2));
