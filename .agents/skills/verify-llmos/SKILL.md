---
name: verify-llmos
description: Verify the llmOS tools by driving the real `llmos` CLI, its MCP server (`llmos mcp`, stdio), and the hook bundle (`dist/hooks.js`) on a scratch copy of a fixture vault. Use after a change to the CLI, the MCP server, or the hooks to see it work, or to audit the feature map.
---

# Verify the llmOS tools

This skill drives the real tools. It never uses the real vault in `llmOS/`.
Every command runs against a scratch copy of a fixture vault, with qmd isolated.

Run it from the repository root. One command does the whole cycle:

```bash
just -f cli/justfile verify-llmos          # all features
just -f cli/justfile verify-llmos hooks mcp   # some features
```

The command is `bun .agents/skills/verify-llmos/scripts/verify.ts run`.
It exits 0 when every check passes.

## Surface

- CLI: `cli/bin/llmos.ts`. This is the main surface.
- MCP server: `llmos mcp`, JSON-RPC on stdio.
- Hooks: `bun dist/hooks.js <event>`, with the hook JSON on stdin.

## Launch

```bash
bun scripts/verify.ts launch
```

Launch makes two folders.

- The evidence folder `artifacts/verify-llmos/<timestamp>/` in the repository. Git ignores it.
- A scratch folder `/tmp/verify-llmos-XXXX/`. It holds a copy of `cli/test/fixtures/vault`
  (`vault/`), a copy of `claims_vault/` (`claims/`), a fake `home/`, `tmp/`, and `bin/` (only `bun`).

Launch then adds the scratch vault as the qmd collection `llmos`.
Isolation follows `cli/test/helpers.ts` `isolatedEnv`: `HOME`, `XDG_CACHE_HOME`,
`XDG_CONFIG_HOME`, `INDEX_PATH`, and `QMD_CONFIG_DIR` all point into the scratch folder.
`LLMOS_ROOT` points at the scratch vault. The child `PATH` has no `obsidian-cli`.
Never point a run at `~/.cache/qmd`.

No server stays alive. Each drive starts its own process. The MCP drive starts
one server and stops it at the end of the drive. The child environment sets
`LLMOS_SERVICE=off`; the `service` drive turns it on, in its own state folder,
and stops the service it started.

Ready means: launch printed `launched:`, and `doctor` prints `DOCTOR OK`.

## Doctor

```bash
bun scripts/verify.ts doctor
```

Doctor is read-only. It checks the Bun version (1.4.x), the fixtures, `dist/hooks.js`,
`cli/node_modules`, that the scratch vault is not the real vault, that qmd is isolated,
that `git status -- llmOS` has not changed since launch, and that `llmos read` works.
Run it first, and again after any failed drive. `drive` runs it before each feature.

## Drive

```bash
bun scripts/verify.ts drive              # every feature
bun scripts/verify.ts drive hooks mcp    # chosen features
```

Read `features/README.md`, then the file of the feature you need.
Each feature file lists the exact commands and the end state that proves it works.
Feature names: `read-search`, `writes`, `claims-lint`, `source-capture`, `hooks`, `memory`, `mcp`, `service`.

Use `--run <evidence folder>` to pick a run. The default is the latest run.

## Evidence

The drive writes one `.txt` file per command under `<evidence folder>/<feature>/`.
Each file has the command, the exit code, stdout, and stderr. The scratch path shows as `$SCRATCH`.
`results.json` lists every check with PASS or FAIL. The MCP drive saves the whole JSON-RPC transcript.

Standards:

- Drive the real command, server, or hook. Do not call internal functions.
- Check the side effect on disk next to the output (the note file, the stamp, the raw folder).
- Mock only the network. `source add` uses `scripts/source-offline.ts`, which replaces
  `Context.fetch` (the network seam) with the recordings in `cli/test/fixtures/web/`.
- Do not fake an Obsidian command. Record its exit 3 and report it as `verified-unreachable`.

## Unreachable features

These need a running Obsidian app with its command line interface on. Without it they exit 3.
This host has no Obsidian, so they are `verified-unreachable`. The harness records the exit 3.

- `llmos move`
- `llmos create --template`
- `llmos file-inbox` and the MCP tool `file_inbox`
- `llmos daily get-or-create`, and `daily append-thought` / MCP `daily_append_thought` when today's daily note is missing (Obsidian creates it from the template)

Also not driven in a proof run, because they download models: `search --semantic`,
`search --hybrid`, and a full `reindex` (embedding). So the `service` drive cannot show
the warm models or the background embed; a scratch probe with real models does. Keyword search and `reindex --no-embed` are driven.

## Network commands

`source add` fetches from the network. A proof run must not.
`scripts/source-offline.ts <vault-root> <source>` runs the same command with the recorded pages.

A real run is `llmos source add <arXiv id or URL>`. It requests `arxiv.org` (or the URL's host)
and the figure images, and it writes `raw/<slug>/` in the vault.
A PDF needs MinerU (`LLMOS_MINERU` or `mineru-kit` on `PATH`). Run a real capture only when
the user asks, and only against a scratch vault.

## Cleanup

```bash
bun scripts/verify.ts cleanup
```

Cleanup removes only the scratch folder of the run. It kills no process by name.
Evidence stays in `artifacts/verify-llmos/<timestamp>/`. Check that it is still there.
`bun scripts/verify.ts run` launches, runs doctor, drives, and cleans up, even when a drive fails.

## Helpers

- `scripts/verify.ts`: `launch`, `doctor`, `drive [feature..]`, `cleanup`, `run [feature..]`.
- `scripts/source-offline.ts <vault-root> <source>`: `source add` on recorded pages.

Both are executable. Call them with `bun`. `verify.ts` reuses `cli/test/mcp-client.ts`.
After you change either script, run `cd cli && bun run typecheck`.
