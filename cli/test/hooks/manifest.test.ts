/**
 * Every `hooks.json` command runs the committed bundle with an event the
 * entry point knows. A misspelled event would exit 0 and do nothing, and
 * no harness would report it. The MCP declaration starts the committed
 * launcher in both harnesses and sets Codex approvals per tool. The plugin
 * root holds no `package.json`, so Claude Code installs no dependencies into
 * the plugin cache.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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

test("the tool matchers cover every file and shell tool of both harnesses", () => {
  const hooks = json("hooks/hooks.json").hooks as Record<string, Groups>;
  const matchers = (event: string) =>
    (hooks[event] ?? []).map((group) => new RegExp(`^(?:${group.matcher})$`));
  const matched = (event: string, tool: string) =>
    matchers(event).some((matcher) => matcher.test(tool));
  for (const tool of ["Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "LS", "apply_patch"]) {
    expect([tool, matched("PreToolUse", tool)]).toEqual([tool, true]);
  }
  expect(matched("PreToolUse", "Bash")).toBe(true);
  for (const tool of ["Write", "Edit", "MultiEdit", "apply_patch"]) {
    expect([tool, matched("PostToolUse", tool)]).toEqual([tool, true]);
  }
  expect(matched("PreToolUse", "TaskCreate")).toBe(false);
});

test("the Codex manifest has no hooks key, which Codex rejects (it finds hooks/hooks.json)", () => {
  expect(json(".codex-plugin/plugin.json")).not.toHaveProperty("hooks");
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
  // Claude Code expands ${CLAUDE_PLUGIN_ROOT} and agy expands ${PLUGIN_ROOT}
  // in args; Codex does not, and joins a relative cwd to the plugin root.
  // With an `mcpServers` path, Codex reads only that file, never `.mcp.json`.
  expect(json(".claude-plugin/plugin.json").mcpServers).toBe("./.mcp.json");
  expect(json(".codex-plugin/plugin.json").mcpServers).toBe("./.codex-mcp.json");
  expect(json(".antigravity-plugin/plugin.json")).not.toHaveProperty("mcpServers");
  const claudePlugin = json(".claude-plugin/plugin.json");
  const codexPlugin = json(".codex-plugin/plugin.json");
  const agyPlugin = json(".antigravity-plugin/plugin.json");
  expect(agyPlugin.name).toBe(SERVER_NAME);
  expect(agyPlugin.version).toBe(claudePlugin.version);
  expect(codexPlugin.version).toBe(claudePlugin.version);
  for (const file of [".mcp.json", ".codex-mcp.json", "mcp_config.json"]) {
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

test("the plugin root holds no package.json for Claude Code to install", () => {
  expect(readdirSync(TOOLS)).not.toContain("package.json");
});

test("Antigravity root hooks.json runs the bundle with valid events and matchers", () => {
  const agyCommand = /^bun --no-env-file --config=\/dev\/null \.\/dist\/hooks\.js ([a-z-]+)$/;
  const hooks = json("hooks.json").llmos as Record<string, unknown>;
  const sessionStart = hooks.SessionStart as { command: string }[];
  const preToolUse = hooks.PreToolUse as Groups;
  const postToolUse = hooks.PostToolUse as Groups;
  const stop = hooks.Stop as { command: string }[];

  expect(sessionStart.map((h) => agyCommand.exec(h.command)?.[1])).toEqual(["session-start"]);
  expect(stop.map((h) => agyCommand.exec(h.command)?.[1])).toEqual(["stop"]);
  expect(
    preToolUse.flatMap((group) => group.hooks.map((h) => agyCommand.exec(h.command)?.[1])),
  ).toEqual(["pre-tool-use", "guard-bash"]);
  expect(
    postToolUse.flatMap((group) => group.hooks.map((h) => agyCommand.exec(h.command)?.[1])),
  ).toEqual(["post-tool-use"]);

  const preMatcher = new RegExp(`^(?:${preToolUse[0]?.matcher})$`);
  for (const tool of [
    "read_file",
    "write_file",
    "edit_file",
    "grep_search",
    "find_by_name",
    "run_command",
    "call_mcp_tool",
    "mcp_llmos_llmos_daily_append_thought",
  ]) {
    expect(preMatcher.test(tool)).toBe(true);
  }
  const guardMatcher = new RegExp(`^(?:${preToolUse[1]?.matcher})$`);
  expect(guardMatcher.test("run_command")).toBe(true);
  const postMatcher = new RegExp(`^(?:${postToolUse[0]?.matcher})$`);
  expect(postMatcher.test("write_file")).toBe(true);
  expect(postMatcher.test("edit_file")).toBe(true);
});
