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
`dist/hooks.js`, which `bun build` bundles from `cli/src/hooks/`. It runs from
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
| SessionStart             | `session-start` | `context.ts`, `cloud.ts`, `links.ts` | Links a vault project's agent folders, then supplies vault context inside the vault and repositories with linked vault docs; in a cloud session, first pulls the vault and links each attached repository |
| PreToolUse (reads/edits) | `pre-tool-use`  | `context.ts`  | Resolves target paths, supplies retrieval context on reads and the authoring contract before writes          |
| PreToolUse (MCP writes)  | `pre-tool-use`  | `context.ts`  | Supplies the schema and authoring contract before `daily_append_thought`, `file_inbox`, and `set_property` |
| PreToolUse (Bash)        | `guard-bash`    | `guard.ts`    | Denies `obsidian-cli` note verbs without `file=`/`path=` and raw `mv`/`rm` of vault notes (exit 2, reason on stderr) |
| PostToolUse (Write/Edit) | `post-tool-use` | `stamp.ts`    | Normalizes and stamps frontmatter, reports authoring findings, and flags the index dirty                     |
| Stop                     | `stop`          | `stop.ts`     | Updates the keyword index **iff** this turn dirtied the vault: `llmos-vault reindex --no-embed`, else `qmd update -c llmos`; never embeds |

The stamp writes through the frontmatter serializer in `cli/src/frontmatter.ts`,
so block scalars, comments, and nested maps keep their data. A note without a
frontmatter block, with a block the serializer refuses, or with invalid UTF-8
is left unchanged. The stamp and reindex hooks share a session-scoped dirty
flag, so concurrent sessions never collide or leak a stale flag into each
other. A hook failure never blocks the tool call, and the hooks never import
qmd (it would cost about 48 ms per call). Embedding is left to a hand-run
`llmos-vault reindex`; `llmos-vault health` counts the documents that still
need it.

In every session, local or cloud, the session-start hook links the agent
folders of the session's project (`$CLAUDE_PROJECT_DIR`, else the payload
`cwd`) when it is a git worktree of a vault project, that is, when
`<root>/projects/<repo>` exists. `<repo>` is the name of the main checkout,
the parent of `git rev-parse --git-common-dir`, so every worktree of a
repository links to the same folders:

| Link | Default target |
| --- | --- |
| `.agents/docs` | `<root>/projects/<repo>` |
| `.agents/scratch` | `~/agent-scratch/<repo>/`, agent scratch that outlives the worktree |
| `artifacts` | `~/artifacts/<repo>/`, durable run output |

When the main checkout already has one of these paths as a symlink, a
worktree reuses its target. The hook creates a missing scratch or artifacts
target folder. It never replaces a path that exists, and it adds each link
it makes to `<git-common-dir>/info/exclude`, which all worktrees share, not
to the repository's `.gitignore`. The vault's own repository gets no
`.agents/docs`. The context names each link made; a session that makes none
adds nothing. A link that fails adds one note that names the link and the
error, and the other links are still made.

The hook runs only at session start, only for the session's project folder,
and only for repositories whose `<root>/projects/<repo>` exists. A worktree
made later in a session gets no links from it; the next session started in
that worktree links it.

In a cloud session (`CLAUDE_CODE_REMOTE=true`), the vault is an attached
repository, checked out beside the session's code repositories (for example
`/home/user/llmos` and `/home/user/agent-toolbox`). The cloud's GitHub proxy
serves only attached repositories, so this is how a cloud session can push
vault notes. The session-start hook first runs `git pull --rebase origin main`
in the vault checkout, with a 6-second limit. Then it links each repository
beside the vault checkout the same way. The context tells the agent to push
vault notes to `main` (`git push origin HEAD:main`), not to the session
branch. A failed pull is reported in the context. The cloud environment's
setup script must set the vault root and install the plugin; the hook does
neither.

Because a hook that cannot start fails silently, the session-start hook
records a heartbeat per agent in `${XDG_STATE_HOME:-~/.local/state}/llmos/hooks.json`
(time, Bun version, bundle SHA-256, plugin root), and `llmos-doctor` fails
for an agent whose installed hooks have not run. See the `setup-llmos`
skill.

After changing `cli/src/hooks/` or `cli/src/mcp-launcher.ts`, rebuild both bundles
with `just hooks` (from `cli/`) and commit them; `just check` and CI fail when one is stale. `bun test/hooks/bench.ts
<vault-copy>` times every event.

Hooks observe supported tool calls, not all filesystem access. Direct file
tools and patch edits have explicit targets; simple shell reads can be
recognized, but arbitrary scripts, pipelines, and other tools may not expose
their targets. Run the authoring check on changed notes at completion even
when a hook produced no diagnostic. `.base` and `.canvas` writes receive
authoring guidance; their format and rendering require their own checks.
