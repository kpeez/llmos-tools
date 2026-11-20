# MCP server

This page is for people who use or change the `llmos` MCP server.

The plugin declares an MCP server named `llmos`, which starts in every Claude
Code, Codex, and Antigravity (`agy`) session where the plugin is enabled. Its
tools are typed, so multi-line text needs no shell quoting, and it keeps one
vault model loaded between calls. Its qmd search work goes to the llmOS
service, which keeps the search models loaded for every session on the host
(see [the service](service.md)).

| Tools | Kind |
| --- | --- |
| `read`, `list`, `neighbors`, `subgraph`, `check`, `health`, `search` | Read |
| `daily_append_thought`, `file_inbox`, `set_property` | Write; each stamps `updated` on the notes it changes |
| `memory_save`, `memory_search`, `memory_forget` | Shared project memory (`projects/<project>/memory/`, ADR-0020) |

The memory tools write the notes and `MEMORY.md` index lines that Claude Code
writes through `autoMemoryDirectory`, so every agent shares one store. They
take an optional `project`, a folder name under `projects/`, never a path.
The session-start context names the session's project, so agents pass it.
Without it, the session's folder picks the project: the client's first MCP
root (Claude Code sends the project), then `CLAUDE_PROJECT_DIR`, then the
folder the agent started the launcher in, which the launcher passes as
`LLMOS_SESSION_CWD` unless that is its own plugin folder (Codex starts it
there, and Codex sends no roots). A folder outside every vault project uses
`personal`; a worktree uses its main checkout's project. With no signal at
all, the call fails instead of guessing: the server's own folder is its
install, not the session's. `memory_save` fails when the index would
pass 200 lines or 25,000 bytes, because agents load only that much.
`memory_search` reads the `memory` qmd collection (`projects/*/memory/*.md`:
the top-level notes of every memory folder) and keeps the notes of the
session's project, never its index. While that collection is missing, it
reads the `llmos` collection and keeps only the topic notes directly in the
memory folder; `llmos doctor` gives the command that adds the collection.
`memory_save` and `memory_forget` update the keyword index of that collection,
so a keyword search finds the change at once; a running service also embeds it
in the background.

Each tool runs the handler of the matching `llmos` command, and its
description comes from that command's help. The server serves only the llmOS
vault and its `llmos` and `memory` qmd collections. Arguments come from a model, so each
handler checks them again, every note must resolve to a real path inside the
real vault root (symbolic links resolved), and there is no shell, move, create,
or arbitrary-file tool. The vault model is read again when a note file
changes on disk, so an edit made with `Write` is visible to the next `read`.

The read tools exist to save tokens, so they can return less than a whole
note. `read` takes `section` (the text under one heading) and
`properties_only` (the frontmatter alone). `list` takes a required `folder`
and returns only the properties of the notes under it unless
`properties_only` is false. The session-start hook tells agents to use these
tools before `Grep` and `Read`.

The `search` and `memory_search` tools ask the service first. When no service
runs, the call starts one in the background and answers from the server's own
qmd store, as the server did before the service existed. When the service
cannot start or fails, the server keeps using its own store, so `llmos mcp`
works the same without the service. `LLMOS_SERVICE=off` turns the service off.

Claude Code reads `.mcp.json`, which runs the committed launcher
`${CLAUDE_PLUGIN_ROOT}/dist/mcp.js`. Codex reads `.codex-mcp.json` (named in
`.codex-plugin/plugin.json`): Codex does not expand plugin-root variables, so
it uses `cwd: "."`, which Codex joins to the plugin root, and it sets the
approvals: read tools run without a prompt, write tools prompt. Antigravity
(`agy`) reads `mcp_config.json`, which expands `${PLUGIN_ROOT}/dist/mcp.js`.
Every manifest runs `bun --no-install --no-env-file --config=/dev/null`, so a
session's project can never load its `.env`, `bunfig.toml` preload, or packages
into the server.

The launcher (`cli/src/mcp-launcher.ts`) runs `llmos mcp` from the install
that `~/.local/bin/llmos` links to, with `GGML_METAL_NO_RESIDENCY=1` (on
macOS a process that loaded a qmd model aborts at exit without it). When the
CLI is missing or predates the server, it serves one tool, `setup`, that says
to run `setup-llmos`, so a session never shows a failed server. `llmos doctor`
starts the same server and fails when it does not list every tool.

Hermes Agent has no plugin manifest for the server: each Hermes profile lists
`llmos mcp` under `mcp_servers` in its `config.yaml` (setup-llmos).

Claude Code names the tools `mcp__plugin_llmos_llmos__<tool>`, and Codex and
Hermes Agent `mcp__llmos__<tool>`. The PreToolUse matcher in `hooks.json`
covers both names. Hermes does not read `hooks.json`, so its MCP write tools
get no hook context; the tools stamp `updated` themselves.
