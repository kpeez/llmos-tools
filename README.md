# llmOS tools

The plugin and maintenance tool for the shared **llmOS Obsidian vault**, which
lives beside this folder in `../llmOS/`. It bundles three skills, lifecycle hooks that keep vault writes
well-formed and indexed, an MCP server with typed vault tools, and the llmOS
CLI: deterministic verbs for vault operations, written in TypeScript and run
by Bun (`src/`, `bin/`). It replaced an earlier Python package
([ADR 0012](../llmOS/projects/llmos/adrs/0012-port-tools-to-typescript-on-bun.md)).

## Install the maintenance tools

The `setup-llmos` skill installs the CLI. By hand, from a checkout or the
plugin root, with `bun` on `PATH`:

```sh
bun <checkout>/tools/scripts/install.ts
```

This copies `tools/` to `~/.local/share/llmos/<version>/`, installs its
dependencies there, and links `llmos-vault`, `llmos-doctor`, `llmos-audit`,
`llmos-daily-activity` (`src/digest.ts`), and `qmd` into `~/.local/bin/`. The
`qmd` is the version the CLI imports (`@tobilu/qmd`, pinned in
`package.json`); keep it the only `qmd` on `PATH`.

## Install the agent plugin

Claude Code:

```text
/plugin marketplace add kpeez/llmos
/plugin install llmos@llmos-vault
```

Codex CLI:

```text
codex plugin marketplace add kpeez/llmos
codex plugin add llmos@llmos-vault
```

## Contents

```text
tools/
├── skills/
│   ├── maintain-llmos/    # vault conventions and maintenance workflows
│   ├── setup-llmos/       # machine access diagnosis + vault-root config
│   └── vault-cli/         # routing table for the llmos-vault CLI
├── hooks/                 # hooks.json: session/tool lifecycle hooks (see below)
├── dist/                  # committed bundles: hooks.js and the MCP launcher mcp.js
├── .mcp.json              # the MCP server for Claude Code (.codex-mcp.json for Codex)
├── src/                   # TypeScript core and the CLI's command registry
├── bin/                   # entry points: llmos-vault, llmos-doctor, llmos-audit, qmd
├── test/                  # bun tests, contract snapshots, and fixture vaults
└── scripts/               # install.ts (the CLI install) and gen-marketplaces.ts
```

## Skills

| Skill            | What it does                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `maintain-llmos` | Maintains the vault through its conventions: filing durable knowledge, project docs, reviews, link/property repair |
| `setup-llmos`    | Diagnoses whether a machine can use the vault (Obsidian CLI, `qmd`), and configures the vault root when missing |
| `vault-cli`      | Routes deterministic vault operations — read, list, move, link, file, daily notes, health — to the `llmos-vault` CLI |

The authoring contract lives in the vault at
`agents/references/authoring.md`. It guides meaningful wikilinks, heading and
block references, aliases, embeds, Bases, callouts, and diagrams. The plugin
delivers that contract when a tool targets vault content, including through a
repository's `.agents/docs` or `.agent/docs` symlink. The generic Obsidian
skills provide syntax help when installed; they do not replace the vault's
own conventions.

After editing a note, run `llmos-vault check <vault-relative-note.md>`.
It reports body links separately from frontmatter links and flags explicit
references to existing notes that are not links. Findings need author review;
the command never rewrites content or invents relationships. A clean check is
not a guarantee of useful connections or correct Obsidian rendering.

## Hooks

`hooks/hooks.json` wires four lifecycle events to one file,
`dist/hooks.js`, which `bun build` bundles from `src/hooks/`. It runs from
the plugin cache with no install step and needs only `bun` on the hook
`PATH`. The same command serves Claude and Codex: each entry names its event
on the command line, and the JSON payload arrives on stdin.

```sh
bun --no-env-file --config=/dev/null "$CLAUDE_PLUGIN_ROOT"/dist/hooks.js <event>
```

The two flags stop Bun from loading the session's project `.env` and
`bunfig.toml` (whose `preload` scripts would otherwise run in every hook).

| Event                    | Hook event      | Source        | Purpose                                                                                                     |
| ------------------------ | --------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| SessionStart             | `session-start` | `context.ts`  | Supplies vault context inside the vault and repositories with linked vault docs                            |
| PreToolUse (reads/edits) | `pre-tool-use`  | `context.ts`  | Resolves target paths, supplies retrieval context on reads and the authoring contract before writes          |
| PreToolUse (MCP writes)  | `pre-tool-use`  | `context.ts`  | Supplies the schema and authoring contract before `daily_append_thought`, `file_inbox`, and `set_property` |
| PreToolUse (Bash)        | `guard-bash`    | `guard.ts`    | Denies `obsidian-cli` note verbs without `file=`/`path=` and raw `mv`/`rm` of vault notes (exit 2, reason on stderr) |
| PostToolUse (Write/Edit) | `post-tool-use` | `stamp.ts`    | Normalizes and stamps frontmatter, reports authoring findings, and flags the index dirty                     |
| Stop                     | `stop`          | `stop.ts`     | Updates the keyword index **iff** this turn dirtied the vault: `llmos-vault reindex --no-embed`, else `qmd update -c llmos`; never embeds |

The stamp writes through the frontmatter serializer in `src/frontmatter.ts`,
so block scalars, comments, and nested maps keep their data. A note without a
frontmatter block, with a block the serializer refuses, or with invalid UTF-8
is left unchanged. The stamp and reindex hooks share a session-scoped dirty
flag, so concurrent sessions never collide or leak a stale flag into each
other. A hook failure never blocks the tool call, and the hooks never import
qmd (it would cost about 48 ms per call). Embedding is left to a hand-run
`llmos-vault reindex`; `llmos-vault health` counts the documents that still
need it.

Because a hook that cannot start fails silently, the session-start hook
records a heartbeat per agent in `${XDG_STATE_HOME:-~/.local/state}/llmos/hooks.json`
(time, Bun version, bundle SHA-256, plugin root), and `llmos-doctor` fails
for an agent whose installed hooks have not run. See the `setup-llmos`
skill.

After changing `src/hooks/` or `src/mcp-launcher.ts`, rebuild both bundles
with `just hooks` and commit them; `just check` and CI fail when one is stale. `bun test/hooks/bench.ts
<vault-copy>` times every event.

Hooks observe supported tool calls, not all filesystem access. Direct file
tools and patch edits have explicit targets; simple shell reads can be
recognized, but arbitrary scripts, pipelines, and other tools may not expose
their targets. Run the authoring check on changed notes at completion even
when a hook produced no diagnostic. `.base` and `.canvas` writes receive
authoring guidance; their format and rendering require their own checks.

Install the plugin separately from the CLI, on each host and for each
agent. Codex requires review and trust of the current hook definitions; an
installed CLI or an old trust entry does not prove active hooks, and any
change to `hooks.json` needs a new approval. See the
`setup-llmos` skill for activation and fresh-session verification. Existing
sessions may retain their previous plugin definitions.

## MCP server

The plugin declares an MCP server named `llmos`, which starts in every Claude
Code and Codex session where the plugin is enabled. Its tools are typed, so
multi-line text needs no shell quoting, and it keeps one vault model and the
qmd search models loaded between calls.

| Tools | Kind |
| --- | --- |
| `read`, `neighbors`, `subgraph`, `check`, `health`, `search` | Read |
| `daily_append_thought`, `file_inbox`, `set_property` | Write; each stamps `updated` and `authors` on the notes it changes |

Each tool runs the handler of the matching `llmos-vault` command, and its
description comes from that command's help. The server serves only the llmOS
vault and its `llmos` qmd collection. Arguments come from a model, so each
handler checks them again, every note must resolve to a real path inside the
real vault root (symbolic links resolved), and there is no shell, move, create,
or arbitrary-file tool. The vault model is read again when a note file
changes on disk, so an edit made with `Write` is visible to the next `read`.

Claude Code reads `.mcp.json`, which runs the committed launcher
`${CLAUDE_PLUGIN_ROOT}/dist/mcp.js`. Codex reads `.codex-mcp.json` (named in
`.codex-plugin/plugin.json`): Codex does not expand plugin-root variables, so
it uses `cwd: "."`, which Codex joins to the plugin root, and it sets the
approvals: read tools run without a prompt, write tools prompt. Both run
`bun --no-install --no-env-file --config=/dev/null`, so a session's project
can never load its `.env`, `bunfig.toml` preload, or packages into the server.

The launcher (`src/mcp-launcher.ts`) runs `llmos-vault mcp` from the install
that `~/.local/bin/llmos-vault` links to, with `GGML_METAL_NO_RESIDENCY=1` (on
macOS a process that loaded a qmd model aborts at exit without it). When the
CLI is missing or predates the server, it serves one tool, `setup`, that says
to run `setup-llmos`, so a session never shows a failed server. `llmos-doctor`
starts the same server and fails when it does not list every tool.

Claude Code names the tools `mcp__plugin_llmos_llmos__<tool>` and Codex
`mcp__llmos__<tool>`; the PreToolUse matcher covers both.

## The `llmos-vault` CLI

Every `llmos-vault` command resolves the vault root, runs a handler that
returns a result, and prints JSON, so agents get predictable, parseable
output for reads, listings, moves, links, daily notes, inbox filing, graph
neighbors, search, and vault health checks. The command registry
(`src/commands.ts`) is the one source of each command's help and of
`skills/vault-cli/references/commands.md`, the routing table skills use to
pick the right verb (`bun bin/llmos-vault.ts docs` renders it).

Vault-root resolution lives in `src/root.ts`, which the CLI, the digest, the
hooks, and the MCP server share, so they agree on where the vault is.

## The TypeScript core

`src/` is the TypeScript core: the vault model, the CLI, the digest, the
plugin hooks, and the MCP server.

- `frontmatter.ts` parses frontmatter with the `yaml` package's Document API
  and writes the canonical form: sorted keys, block-style lists, quoted
  wikilinks, one blank line after `---`, no trailing whitespace except a
  Markdown hard line break (two or more spaces) on a body line, one final
  newline. Block scalars, comments, and nested maps survive; a block with YAML
  errors is never rewritten; `created` is immutable and `authors` append-only.
  Every scalar reads as a string.
- `vault.ts` loads every note once into one `VaultModel` with Obsidian's link
  resolution, and answers `read`, `list`, `neighbors`, `subgraph`, and the
  health link findings from it.
- `root.ts` resolves the vault root and Obsidian's vault registry, and throws
  `VaultRootError` instead of exiting.
- `schema.ts`, `authoring.ts`, `health.ts`, `daily.ts`, and `inbox.ts` port the
  llmOS-profile reads and computations.
- `cli.ts` and `commands.ts` are the `llmos-vault` command registry and entry
  point; `write.ts` does the headless writes, `obsidian.ts` the two
  obsidian-cli writes (`move`, `create --template`), `qmd.ts` search and
  reindex through the qmd SDK, and `doctor.ts` the `llmos-doctor` checks.
- `digest.ts` is the `llmos-daily-activity` command (run it with
  `bun src/digest.ts`). It writes the block hash and markers the earlier
  Python digest wrote for the same GitHub activity, with one fix: a PR
  merged in one repository no longer hides a PR with the same number opened
  in another.
- `hooks/` holds the plugin hooks, bundled into `dist/hooks.js` (see
  [Hooks](#hooks)).
- `mcp.ts` is the `llmos-vault mcp` server, `mcp-launcher.ts` the launcher
  bundled into `dist/mcp.js`, `mcp-check.ts` the doctor's server check, and
  `mcp-names.ts` the tool names the hooks share (see [MCP server](#mcp-server)).

Set up with `bun install --frozen-lockfile`; check with `just types`,
`just lint`, and `just test`, or all of them with `just check`.

## Scripts

- **`llmos-doctor`** — end-to-end health check: is the vault root valid, are
  the CLI and `qmd` reachable, is the collection indexed, does the MCP server
  start and list its tools, and have the installed plugin hooks run for each
  agent.
- **`llmos-audit`** — audits frontmatter contracts across the vault; read-only.
- **`llmos-daily-activity`** — writes the machine-owned `## Projects` block of
  daily notes from GitHub activity. Deterministic: fetch → hash → one model
  call → verify → write. It runs the model as an opencode agent with every
  tool denied.
- **`scripts/`** — `install.ts`, the CLI install, and `gen-marketplaces.ts`,
  which writes the marketplace catalogs at the repository root (`just gen`;
  `just check` and CI fail when a catalog is stale).

## Tests

`test/` holds the `bun test` unit tests for the TypeScript core and the hook
tests in `test/hooks/` (gating, guards, stamp format, reindex; each runs the
hook as a `bun` process, as the harnesses do). `test/contract/` pins the
external contract with committed snapshots: the CLI's JSON output and exit
codes (except `list`'s exit code), the canonical `normalize` output, and the
schema audit on the fixture vaults in `test/fixtures/` and a generated
edge-case vault, and the activity
digest's outcomes, block hashes, markers, and notes on generated edge days
with a stand-in `gh` and model. The snapshots were recorded while the Python
package was still the reference and checked against it; each result where
TypeScript intentionally differs names the reason. After an intended contract
change, `just contract-record` records them again for review.

The same tests check the frontmatter invariants on every note: reading never
fails with an untyped error, `normalize` refuses no valid YAML, keeps every
value, and is idempotent. `just invariants <vault-copy>` checks them on a
copy of the real vault.
