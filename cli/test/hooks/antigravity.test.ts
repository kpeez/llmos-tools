/**
 * The JSON that each hook prints for Antigravity (`agy`) on stdout, with exit
 * code 0 and an empty stderr. One row per event and verdict.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  makeVault,
  removeTemporaryFolders,
  runHook,
  temporaryFolder,
  writeFile,
} from "./helpers.ts";

afterEach(removeTemporaryFolders);

const SCHEMA_SENTINEL = "SCHEMA-CONTRACT-SENTINEL";
const MESSY_NOTE = "---\ncreated: 2026-07-01\n---\n# A note\n\nBody [[Some Other Note]].\n";

interface Paths {
  tmp: string;
  vault: string;
  note: string;
  memory: string;
}

const tool = (name: string, args: Record<string, unknown>) => ({
  hookEventName: "PreToolUse",
  conversationId: "conv-1",
  toolCall: { name, args },
});

const mcp = (server: string, toolName: string, args: Record<string, unknown> = {}) =>
  tool("call_mcp_tool", { ServerName: server, ToolName: toolName, Arguments: args });

const ALLOW = { decision: "allow" };
const needsSchema = { decision: "allow", reason: expect.stringContaining(SCHEMA_SENTINEL) };

const CASES: [
  name: string,
  event: string,
  payload: (p: Paths) => unknown,
  expected: (p: Paths) => unknown,
  env?: Record<string, string>,
][] = [
  [
    "guard-bash denies a raw rm of a note and names it",
    "guard-bash",
    (p) => tool("run_command", { CommandLine: `rm ${p.note}` }),
    (p) => ({ decision: "deny", reason: expect.stringContaining(p.note) }),
  ],
  [
    "guard-bash allows a command that touches no note",
    "guard-bash",
    () => tool("run_command", { CommandLine: "git status" }),
    () => ALLOW,
  ],
  [
    "pre-tool-use allows a read of a vault note and says what it is",
    "pre-tool-use",
    (p) => tool("read_file", { Path: p.note }),
    () => ({ decision: "allow", reason: expect.stringContaining("Obsidian vault note") }),
  ],
  [
    "pre-tool-use allows a read of a MEMORY.md with no reason",
    "pre-tool-use",
    (p) => tool("read_file", { Path: p.memory }),
    () => ALLOW,
  ],
  [
    "pre-tool-use adds the schema to a file write of a note",
    "pre-tool-use",
    (p) => tool("edit_file", { TargetFile: p.note }),
    () => needsSchema,
  ],
  [
    "pre-tool-use adds the schema to a vault write through the llmos server",
    "pre-tool-use",
    () => mcp("llmos", "set_property"),
    () => needsSchema,
  ],
  [
    "pre-tool-use adds the schema to a vault write through the prefixed server name",
    "pre-tool-use",
    () => mcp("llmos_llmos", "set_property"),
    () => needsSchema,
  ],
  [
    "pre-tool-use adds the schema to a direct MCP write tool",
    "pre-tool-use",
    () => tool("mcp_llmos_llmos_daily_append_thought", { text: "hi" }),
    () => needsSchema,
  ],
  [
    "pre-tool-use allows an MCP read with no reason",
    "pre-tool-use",
    () => mcp("llmos", "read", { note: "a" }),
    () => ALLOW,
  ],
  [
    "session-start inside the vault injects one system message",
    "session-start",
    (p) => ({
      hookEventName: "SessionStart",
      conversationId: "conv-1",
      workspacePaths: [p.vault],
    }),
    (p) => ({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: expect.stringMatching(
              new RegExp(`^(?=[\\s\\S]*llmOS root: ${p.vault}\\.)(?=[\\s\\S]*# Vault Memory)`),
            ),
          },
        },
      ],
    }),
    { PLUGIN_ROOT: "/agy/plugins/llmos" },
  ],
  [
    "session-start outside the vault prints {}",
    "session-start",
    (p) => ({
      hookEventName: "SessionStart",
      conversationId: "conv-2",
      workspacePaths: [p.tmp],
    }),
    () => ({}),
    { ANTIGRAVITY_CLI: "1" },
  ],
  [
    "post-tool-use prints {}",
    "post-tool-use",
    (p) => ({
      hookEventName: "PostToolUse",
      conversationId: "conv-agy",
      toolCall: { name: "write_file", args: { TargetFile: p.note } },
    }),
    () => ({}),
    { ANTIGRAVITY_CLI: "1" },
  ],
  [
    "stop prints {}",
    "stop",
    () => ({ hookEventName: "Stop", conversationId: "conv-agy" }),
    () => ({}),
    { ANTIGRAVITY_CLI: "1" },
  ],
];

describe("Antigravity hook output", () => {
  test.each(CASES)("%s", (_name, event, payload, expected, env = {}) => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    writeFile(join(vault, "schema.md"), `${SCHEMA_SENTINEL}\n`);
    const note = writeFile(join(vault, "projects", "testproj", "notes", "a.md"), MESSY_NOTE);
    const memory = writeFile(join(vault, "projects", "testproj", "memory", "MEMORY.md"), "# M\n");
    writeFile(join(vault, "projects", "llmos", "memory", "MEMORY.md"), "# Vault Memory\n");
    const paths = { tmp, vault, note, memory };

    const result = runHook(event, payload(paths), tmp, {
      root: vault,
      env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(expected(paths));
  });
});
