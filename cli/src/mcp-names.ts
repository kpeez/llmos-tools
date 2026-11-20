/**
 * The llmOS MCP server's name and tool names, shared by the server
 * (`mcp.ts`) and the hooks, which must not import the MCP SDK.
 */

/** The server name in the plugin's `.mcp.json`. */
export const SERVER_NAME = "llmos";

export const READ_TOOLS = [
  "read",
  "list",
  "neighbors",
  "subgraph",
  "check",
  "health",
  "search",
] as const;
/**
 * Shared project memory tools. They format their own notes, so they are not
 * write tools: the PreToolUse hook gives write tools the durable-note
 * authoring contract, which memory notes do not follow.
 */
export const MEMORY_TOOLS = ["memory_save", "memory_search", "memory_forget"] as const;
export const WRITE_TOOLS = ["daily_append_thought", "file_inbox", "set_property"] as const;

/**
 * A harness tool name of one of the server's write tools. Claude Code names
 * a plugin server's tools `mcp__plugin_<plugin>_<server>__<tool>`; Codex
 * names them `mcp__<server>__<tool>`.
 */
export const MCP_WRITE_TOOL = new RegExp(
  `^mcp__(?:plugin_llmos_)?${SERVER_NAME}__(?:${WRITE_TOOLS.join("|")})$`,
);

/** Antigravity direct tool name for an llmOS MCP write tool. */
export const AGY_MCP_WRITE_TOOL = new RegExp(
  `^mcp_${SERVER_NAME}_(?:${SERVER_NAME}_)?(?:${WRITE_TOOLS.join("|")})$`,
);

/** Whether a tool call invokes one of the llmOS MCP write tools in any harness. */
export function isMcpWriteTool(
  toolName: string,
  toolInput: Record<string, unknown> | null,
): boolean {
  if (MCP_WRITE_TOOL.test(toolName) || AGY_MCP_WRITE_TOOL.test(toolName)) return true;
  return (
    toolName === "call_mcp_tool" &&
    toolInput !== null &&
    (toolInput.ServerName === SERVER_NAME ||
      toolInput.ServerName === `${SERVER_NAME}_${SERVER_NAME}`) &&
    typeof toolInput.ToolName === "string" &&
    (WRITE_TOOLS as readonly string[]).includes(toolInput.ToolName)
  );
}
