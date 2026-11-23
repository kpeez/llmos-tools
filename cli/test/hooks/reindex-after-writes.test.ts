/**
 * Every way a turn can change the vault makes the Stop hook reindex, so a
 * keyword search finds the new text right after the turn. Each test drives
 * the real pieces on a scratch vault and an isolated qmd index: a real
 * `llmos mcp` server process for the MCP write tools, the hook entry for
 * PostToolUse and Stop, and the CLI for `source add`. The MCP server, the
 * CLI, and the hooks share one llmOS state folder (`XDG_STATE_HOME`), as
 * they do under one harness.
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "../../src/hooks/common.ts";
import { cli, dailyNote, indexVault, isolatedEnv, makeVault } from "../helpers.ts";
import { McpClient } from "../mcp-client.ts";
import { CLI, removeTemporaryFolders, runHook, temporaryFolder } from "./helpers.ts";

afterEach(removeTemporaryFolders);

const ENTRY = join(CLI, "bin", "llmos.ts");
const INBOX = "---\nstatus: draft\n---\n\n# Capture\n\nA loose idea.\n";

interface Turn {
  root: string;
  env: Record<string, string>;
  tmp: string;
  bin: string;
}

async function turn(): Promise<Turn> {
  const today = localDate();
  const root = makeVault({
    "notes/alpha.md": "---\nstatus: draft\n---\n\n# Alpha\n\nPlain text.\n",
    "raw/capture.md": INBOX,
    [`daily/${today}.md`]: dailyNote(today),
  });
  const tmp = temporaryFolder();
  const env = isolatedEnv({ XDG_STATE_HOME: join(tmp, "state") });
  await indexVault(root, env);
  // `llmos` for the Stop hook, and an obsidian-cli that moves as the app would.
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "llmos"), `#!/bin/sh\nexec "${process.execPath}" "${ENTRY}" "$@"\n`);
  writeFileSync(
    join(bin, "obsidian-cli"),
    `#!/bin/sh\n[ "$2" = move ] || exit 1\nfrom="${root}/\${3#path=}"\nto="${root}/\${4#to=}"\n` +
      'mkdir -p "$(dirname "$to")" && mv "$from" "$to"\n',
  );
  chmodSync(join(bin, "llmos"), 0o755);
  chmodSync(join(bin, "obsidian-cli"), 0o755);
  return { root, env, tmp, bin };
}

/** The paths a keyword search of the `llmos` collection finds for `query`. */
async function found(t: Turn, query: string): Promise<string[]> {
  const result = await cli(t.root, ["search", query], { env: t.env });
  return (JSON.parse(result.stdout) as { path: string }[]).map((hit) => hit.path);
}

/** Call `tool` on a real `llmos mcp` server process. */
async function callTool(t: Turn, tool: string, args: Record<string, unknown>): Promise<string> {
  const server = Bun.spawn([process.execPath, "--no-env-file", ENTRY, "mcp"], {
    env: {
      ...t.env,
      LLMOS_ROOT: t.root,
      GGML_METAL_NO_RESIDENCY: "1",
      // `bun test` runs in UTC; the server must see the same "today" as the test.
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
      PATH: `${t.bin}:/usr/bin:/bin`,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const client = new McpClient((line) => {
      server.stdin.write(line);
      server.stdin.flush();
    }, server.stdout);
    await client.initialize("claude-code");
    const result = await client.call(tool, args);
    expect(result).toMatchObject({ isError: false });
    return result.text;
  } finally {
    server.stdin.end();
    await server.exited;
  }
}

function stop(t: Turn) {
  const result = runHook("stop", { session_id: "sess-e2e" }, t.tmp, {
    root: t.root,
    env: { ...t.env, PATH: `${t.bin}:/usr/bin:/bin` },
  });
  expect(result.exitCode).toBe(0);
  return result;
}

test("daily_append_thought: the thought is found after Stop", async () => {
  const t = await turn();
  await callTool(t, "daily_append_thought", { text: "The kestrel hovers over the quarry." });
  expect(await found(t, "kestrel")).toEqual([]);

  stop(t);

  expect(await found(t, "kestrel")).toEqual([`daily/${localDate()}.md`]);
});

test("set_property: the new value is found after Stop", async () => {
  const t = await turn();
  await callTool(t, "set_property", { note: "notes/alpha.md", key: "status", value: "osprey" });

  stop(t);

  expect(await found(t, "osprey")).toEqual(["notes/alpha.md"]);
});

test("file_inbox: the note is found at its new path after Stop", async () => {
  const t = await turn();
  await callTool(t, "file_inbox", { note: "raw/capture.md", destination: "knowledge/capture" });

  stop(t);

  expect(await found(t, "loose idea")).toEqual(["knowledge/capture.md"]);
});

test("source add: the captured text is found after Stop", async () => {
  const t = await turn();
  const replay = async (url: string) => {
    const file = join(CLI, "test", "fixtures", "web", "example.org", "papers", "open-study.html");
    const body = new Uint8Array(await Bun.file(file).arrayBuffer());
    return url.endsWith("open-study.html")
      ? { status: 200, url, contentType: "text/html; charset=utf-8", body }
      : { status: 404, url, contentType: "text/html", body: new Uint8Array() };
  };
  // The CLI runs in this process, so it takes the turn's state folder here.
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = t.env.XDG_STATE_HOME;
  try {
    const argv = ["source", "add", "https://example.org/papers/open-study.html"];
    const result = await cli(t.root, argv, { env: t.env, fetch: replay });
    expect(result.exitCode).toBe(0);
  } finally {
    process.env.XDG_STATE_HOME = saved;
  }

  stop(t);

  expect((await found(t, "species")).some((path) => path.endsWith("/source.md"))).toBe(true);
});

test.each([
  ["with frontmatter", "---\nstatus: draft\n---\n\n# Heron\n\nThe heron waits.\n"],
  ["without frontmatter", "# Heron\n\nThe heron waits.\n"],
])("a Write to a note %s is found after Stop", async (_label, text) => {
  const t = await turn();
  const note = join(t.root, "notes", "heron.md");
  writeFileSync(note, text);
  const post = runHook(
    "post-tool-use",
    { session_id: "sess-e2e", tool_name: "Write", tool_input: { file_path: note } },
    t.tmp,
    { root: t.root, env: t.env },
  );
  expect(post.exitCode).toBe(0);

  stop(t);

  expect(await found(t, "heron")).toEqual(["notes/heron.md"]);
});
