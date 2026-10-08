/**
 * Every `hooks.json` command runs the committed bundle with an event the
 * entry point knows. A misspelled event would exit 0 and do nothing, and
 * no harness would report it. The MCP declaration starts the committed
 * launcher in both harnesses and sets Codex approvals per tool.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_WRITE_TOOL, READ_TOOLS, SERVER_NAME, WRITE_TOOLS } from "../../src/mcp-names.ts";
import { TOOLS } from "./helpers.ts";

const COMMAND =
  /^bun --no-env-file --config=\/dev\/null "\$CLAUDE_PLUGIN_ROOT"\/dist\/hooks\.js ([a-z-]+)$/;

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(TOOLS, path), "utf8"));
}

type Groups = { matcher?: string; hooks: { command: string }[] }[];

test("each hook command runs the bundle with a known event", () => {
  const hooks = json("hooks/hooks.json").hooks as Record<string, Groups>;
  const events: Record<string, string[]> = {};
  for (const [name, groups] of Object.entries(hooks)) {
    events[name] = groups.flatMap((group) =>
      group.hooks.map((hook) => COMMAND.exec(hook.command)?.[1] ?? hook.command),
    );
  }
  expect(events).toEqual({
    SessionStart: ["session-start"],
    PreToolUse: ["pre-tool-use", "pre-tool-use", "guard-bash"],
    PostToolUse: ["post-tool-use"],
    Stop: ["stop"],
  });
});

test("the MCP PreToolUse matcher fires for the write tools under both harness names", () => {
  const groups = (json("hooks/hooks.json").hooks as Record<string, Groups>).PreToolUse ?? [];
  const matcher = groups[1]?.matcher as string;
  expect(matcher).toBe(MCP_WRITE_TOOL.source);
  // Both harnesses treat a matcher with regex characters as an unanchored regex.
  const regex = new RegExp(matcher);
  for (const tool of WRITE_TOOLS) {
    expect(regex.test(`mcp__plugin_llmos_${SERVER_NAME}__${tool}`)).toBe(true);
    expect(regex.test(`mcp__${SERVER_NAME}__${tool}`)).toBe(true);
  }
  for (const name of [
    ...READ_TOOLS.map((tool) => `mcp__plugin_llmos_${SERVER_NAME}__${tool}`),
    `mcp__other__set_property`,
    `mcp__plugin_llmos_${SERVER_NAME}__set_property_extra`,
    "Write",
  ]) {
    expect(regex.test(name)).toBe(false);
  }
});

test("each manifest declares one llmos server in its own file", () => {
  // Claude Code expands ${CLAUDE_PLUGIN_ROOT} in args; Codex does not, but
  // joins a relative cwd to the plugin root. With an `mcpServers` path,
  // Codex reads only that file, never the root `.mcp.json`.
  expect(json(".claude-plugin/plugin.json").mcpServers).toBe("./.mcp.json");
  expect(json(".codex-plugin/plugin.json").mcpServers).toBe("./.codex-mcp.json");
  for (const file of [".mcp.json", ".codex-mcp.json"]) {
    expect(Object.keys(json(file).mcpServers as object)).toEqual([SERVER_NAME]);
  }
});

test("Codex approves the read tools and prompts for the write tools", () => {
  const server = (json(".codex-mcp.json").mcpServers as Record<string, Record<string, unknown>>)[
    SERVER_NAME
  ] as Record<string, unknown>;
  expect(server.default_tools_approval_mode).toBe("prompt");
  const modes = Object.fromEntries(
    Object.entries(server.tools as Record<string, { approval_mode: string }>).map(
      ([tool, config]) => [tool, config.approval_mode],
    ),
  );
  expect(modes).toEqual({
    ...Object.fromEntries(READ_TOOLS.map((tool) => [tool, "approve"])),
    setup: "approve",
    ...Object.fromEntries(WRITE_TOOLS.map((tool) => [tool, "prompt"])),
  });
});
