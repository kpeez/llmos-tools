/**
 * The llmOS MCP server's name and tool names, shared by the server
 * (`mcp.ts`) and the hooks, which must not import the MCP SDK.
 */

/** The server name in the plugin's `.mcp.json`. */
export const SERVER_NAME = "llmos";

export const READ_TOOLS = ["read", "neighbors", "subgraph", "check", "health", "search"] as const;
export const WRITE_TOOLS = ["daily_append_thought", "file_inbox", "set_property"] as const;

/**
 * A harness tool name of one of the server's write tools. Claude Code names
 * a plugin server's tools `mcp__plugin_<plugin>_<server>__<tool>`; Codex
 * names them `mcp__<server>__<tool>`.
 */
export const MCP_WRITE_TOOL = new RegExp(
  `^mcp__(?:plugin_llmos_)?${SERVER_NAME}__(?:${WRITE_TOOLS.join("|")})$`,
);
