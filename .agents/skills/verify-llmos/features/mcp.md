# MCP server

`llmos mcp` serves the vault tools to an agent over MCP on stdio (newline-delimited JSON-RPC). Arguments come from a model, so the server checks each one and keeps every path inside the vault.

## Sub-features

- `list-tools` names the tools: `read`, `list`, `neighbors`, `subgraph`, `check`, `health`, `search`, `memory_save`, `memory_search`, `memory_forget`, `daily_append_thought`, `file_inbox`, `set_property`.
- `memory-tools` save and forget a memory in `projects/verify/memory/`.
- `read-tools` return note data and search results.
- `write-tools` change a note and stamp `updated`.
- `argument-checks` refuse an unknown argument, a path outside the vault, and a link out of the vault.
- `file_inbox` (the move) and `daily_append_thought` (the daily note is created through it) need Obsidian here. Verified-unreachable.

## How to get to it (user POV)

- Claude Code starts the server from `.mcp.json`. Codex uses `.codex-mcp.json`.
- By hand: `bun --no-env-file --config=/dev/null cli/bin/llmos.ts mcp`.

## Driving it with scripts/verify.ts

Preconditions: launch and doctor passed. `drive read-search` ran first, so the qmd index exists. `drive writes` ran first, so `notes/link.md` exists. The client is `cli/test/mcp-client.ts`, connected to the child's stdio. It identifies as `claude-code`.

- **List tools.** `tools/list` names the tools above. No shell, move, or create tool.
- **Read.** `tools/call read {"note":"notes/alpha.md"}`. Not an error. The text holds `gardening`.
- **Search.** `tools/call search {"query":"gardening"}`. Not an error. The text names `notes/beta.md`.
- **Write.** `tools/call set_property {"note":"notes/beta.md","key":"status","value":"active"}`. `notes/beta.md` holds `status: active` and `updated`.
- **Thought (verified-unreachable).** `tools/call daily_append_thought {"text":"..."}` is an error: no `obsidian-cli`. Today's daily note does not exist in the fixture, and Obsidian creates it from the template.
- **Outside the vault.** `read {"note":"../../etc/passwd"}` is an error. `set_property` on `notes/link.md` is an error.
- **Memory.** `memory_save {"name":"tank-heater",...,"project":"verify"}` writes `projects/verify/memory/tank-heater.md`; `memory_forget` deletes it. `memory_save` with `"project":".."` is an error. Prerequisite: `drive memory` made `projects/verify/`.
- **Unknown argument.** `read {"note":"notes/alpha.md","shell":"id"}` is an error.
- **file_inbox (verified-unreachable).** `file_inbox {"note":"notes/alpha.md","destination":"notes/z.md"}` is an error: no Obsidian. Prerequisite: the Obsidian app running with its CLI on.
- Run: `bun scripts/verify.ts drive mcp`. Evidence goes to `mcp/01-transcript.txt`.

## Gotchas

- `drive mcp` alone works only if the qmd index exists. Run `drive read-search` first or run all features.
- The MCP `search` needs the `llmos` qmd collection. The server reads `INDEX_PATH` from its environment, so the child env must keep the isolation.
- The server stamps notes itself. The PostToolUse hook does not see MCP calls.
- The plugin starts the server through the launcher `dist/mcp.js`. The harness starts `llmos mcp` directly. The launcher is not driven.
