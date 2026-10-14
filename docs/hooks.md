# Hooks

This page is for people who install, debug, or change the plugin hooks.

## Activate

Install the plugin separately from the CLI, on each host and for each
agent. Codex requires review and trust of the current hook definitions; an
installed CLI or an old trust entry does not prove active hooks, and any
change to `hooks.json` needs a new approval. See the
`setup-llmos` skill for activation and fresh-session verification. Existing
sessions may retain their previous plugin definitions.

## How they run

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
