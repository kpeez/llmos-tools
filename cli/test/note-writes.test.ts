/**
 * Concurrent writers of one note, as real processes: the `llmos` CLI and the
 * MCP server read, change, and replace a note, so two writers at once must not
 * lose each other's change.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { localDate } from "../src/hooks/common.ts";
import { isolatedEnv, makeVault, read } from "./helpers.ts";
import { McpClient } from "./mcp-client.ts";

const CLI = join(import.meta.dir, "..");
const DAILY = `daily/${localDate()}.md`;
const NOTE = [
  "---",
  "updated: 2026-01-01",
  "---",
  "",
  "## Thoughts",
  "",
  "<!-- llmos-activity:start -->",
  "<!-- llmos-activity:end -->",
  "",
].join("\n");
const CLI_WRITERS = 10;
const MCP_WRITERS = 3;
const MCP_CALLS = 4;

function command(env: Record<string, string>, argv: string[]) {
  return Bun.spawn([process.execPath, join(CLI, "bin/llmos.ts"), ...argv], {
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
}

async function mcpWriter(env: Record<string, string>, index: number): Promise<string[]> {
  const proc = Bun.spawn([process.execPath, join(CLI, "bin/llmos.ts"), "mcp"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = new McpClient((line) => {
    proc.stdin.write(line);
    proc.stdin.flush();
  }, proc.stdout);
  await client.initialize("test");
  const failures: string[] = [];
  for (let call = 0; call < MCP_CALLS; call++) {
    const text = `mcp-${index}-${call}`;
    const result = await client.call("daily_append_thought", { text });
    if (result.isError) failures.push(`${text}: ${result.text}`);
  }
  proc.stdin.end();
  await proc.exited;
  return failures;
}

test("thoughts and properties written at once by CLI and MCP processes are all kept", async () => {
  const root = makeVault({ [DAILY]: NOTE });
  // `bun test` runs in UTC: give the processes the same clock, or they find another day's note.
  const env = isolatedEnv({ LLMOS_ROOT: root, TZ: process.env.TZ ?? "UTC" });
  const expected: string[] = [];
  const procs = Array.from({ length: CLI_WRITERS }, (_, i) => {
    expected.push(`cli-${i}`);
    return command(env, ["daily", "append-thought", `cli-${i}`]);
  });
  const properties = Array.from({ length: CLI_WRITERS }, (_, i) =>
    command(env, ["set-property", DAILY, "topics", `[[Topic${i}]]`]),
  );
  const mcp = Array.from({ length: MCP_WRITERS }, (_, i) => {
    for (let call = 0; call < MCP_CALLS; call++) expected.push(`mcp-${i}-${call}`);
    return mcpWriter(env, i);
  });

  const failures = (await Promise.all(mcp)).flat();
  for (const proc of [...procs, ...properties]) {
    if ((await proc.exited) !== 0) failures.push(await new Response(proc.stderr).text());
  }
  const text = read(root, DAILY);

  expect(failures).toEqual([]);
  expect(expected.filter((thought) => !text.includes(thought))).toEqual([]);
  const topics = Array.from({ length: CLI_WRITERS }, (_, i) => `[[Topic${i}]]`);
  expect(topics.filter((topic) => !text.includes(topic))).toEqual([]);
}, 60_000);
