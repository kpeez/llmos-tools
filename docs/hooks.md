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
| SessionStart             | `session-start` | `context.ts`, `cloud.ts`, `links.ts` | Links a vault project's agent folders, then supplies vault context inside the vault and repositories with linked vault docs; in a cloud session, first pulls the vault and links each attached repository; in a local session, first fetches and fast-forwards the vault's shared memory (`sync.ts`) |
| PreToolUse (reads/edits) | `pre-tool-use`  | `context.ts`  | Resolves target paths, supplies retrieval context on reads and the authoring contract before writes          |
| PreToolUse (MCP writes)  | `pre-tool-use`  | `context.ts`  | Supplies the schema and authoring contract before `daily_append_thought`, `file_inbox`, and `set_property` |
| PreToolUse (Bash)        | `guard-bash`    | `guard.ts`    | Denies `obsidian-cli` note verbs without `file=`/`path=` and raw `mv`/`rm` of vault notes (exit 2, reason on stderr) |
| PostToolUse (Write/Edit) | `post-tool-use` | `stamp.ts`    | Normalizes and stamps frontmatter, reports authoring findings, and flags the index dirty                     |
| Stop                     | `stop`          | `stop.ts`, `sync.ts` | Updates the keyword index **iff** this turn dirtied the vault: `llmos reindex --no-embed` (the `llmos` collection, and `memory` when it exists), else `qmd update -c llmos` (qmd scans every collection); never embeds. Then commits changed shared project memory and pushes it |

## Hermes Agent

Hermes Agent does not read `hooks/hooks.json`. The adapter plugin in
`hermes/` (Python, standard library only) runs the same `dist/hooks.js`
for each Hermes hook, sends the payload the bundle reads for Claude Code
(Hermes tool names mapped to `Bash`, `Read`, `Grep`, `Write`, `Edit`, or
`apply_patch`), and sets `PLUGIN_ROOT=~/.hermes/plugins/llmos` so the
heartbeat names `hermes`. Each Hermes profile links
`~/.local/share/llmos/current/hermes` into its own `plugins/` folder and
enables it (setup-llmos, "Hermes Agent"). `install.ts` moves `current` to each
new install, so Hermes runs an installed copy, never a checkout.

| Hermes hook | Hook event | When |
| --- | --- | --- |
| `pre_llm_call` | `session-start` | First turn of a session only; the output is context for that turn |
| `pre_tool_call` | `guard-bash` | `terminal` calls; exit 2 blocks the call |
| `transform_tool_result` | `pre-tool-use` | `read_file` and `search_files` on a vault path; the context is appended to the result |
| `transform_tool_result` | `post-tool-use` | `write_file` and `patch` on a vault path; stamps the note and appends the findings |
| `on_session_end` | `stop` | End of every turn; runs in the background |
| `pre_verify` | none (git in the adapter) | After `write_file` or `patch` edits: sends the agent back, at most twice, while a vault note it changed that way this turn is uncommitted or not pushed. Shared project memory is left out, and a branch with no upstream skips the push check. Shell and MCP writes do not trigger it |

Hermes has no channel for context before a tool runs, so a write gets no
authoring contract first; the `maintain-llmos` skill carries it. A Hermes
shell hook (`hooks:` in `config.yaml`) cannot replace a tool result, which
is why the adapter is a plugin. Every adapter error returns no result: an
error raised in `pre_tool_call` makes Hermes block the tool call.

Relative paths resolve against the call's `workdir`, then the session cwd
that Hermes records (`get_session_cwd`), then `TERMINAL_CWD`. As for
Claude, the guard does not follow a `cd` inside a command, and it does not
see `execute_code` or other tools that run code.

The same plugin registers a Hermes memory provider, `llmos`
(`hermes/memory_provider.py`). Hermes uses it only in a profile whose
`config.yaml` sets `memory.provider: llmos`. It puts the shared project
memory index (`projects/<project>/memory/MEMORY.md`, with the session-start
hook's bounds) and a note on which memory takes which fact in the system
prompt, and it gives Hermes `memory_save`, `memory_search`, and
`memory_forget`, which run `llmos memory` from the same install. The project
comes from the session's folder: the `cwd` that Hermes passes, then the
profile's `TERMINAL_CWD`; with neither, it is `personal`. Hermes's
`agent_workspace` is a fixed label, not a folder, so the provider does not
read it. Subagent, cron, and flush sessions read memory but never write it.
The provider needs Hermes v2026.9.14 (0.21.3) or later, the first release whose
`agent.memory_provider` has `spawn_context_thread`, `RecallStatus`, and
`is_trivial_prompt`. With an older Hermes the provider fails to load.
After each turn that is not a bare acknowledgement or slash command, the
provider recalls memories for the next turn on a background thread. It pools
the top five scope topic notes that share a word with the prompt and the first
five hits of `llmos memory search` (by meaning, through the llmOS service when
it runs, `docs/service.md`) that score at least 0.45. The keyword search of qmd
needs every word of a query, so the word match is the provider's own.

With `LLMOS_RECALL_JUDGE_URL` set to the base URL of a SystemOne server that
runs a decision model, the provider posts the pool to `<URL>/v1/systemone` in
one request and keeps the notes that the model rates helpful with a probability
of at least its threshold, best first, at most five. `LLMOS_RECALL_JUDGE_MODEL`
names the model in the request (default `d1-2B`). The threshold follows the
model: 0.5 for `d1-2B`, 0.3 for `clef-flash`. An offline evaluation picked each
value. `LLMOS_RECALL_JUDGE_THRESHOLD`, a number from 0 to 1, overrides it; the
provider ignores an invalid value and logs one warning. A model with no
threshold and no override never calls the judge: recall is semantic-only, and
the provider logs one warning at start that names the model.
`LLMOS_RECALL_JUDGE_TIMEOUT` is the deadline for the whole call in seconds
(default 5; a bad value uses the default). The provider reads the four variables
at start. When the judge is not set, or fails, recall is semantic-only: the
first two semantic hits that score at least 0.75. The word match then adds
nothing, so a memory saved a moment ago is not found until it is embedded,
unless the judge is configured. Recall reads only regular files inside the
vault: it skips a memory note that is a symbolic link, that it cannot read,
or that is not UTF-8. A memory folder that resolves outside the vault, or that
it cannot resolve or read, gets no recall and one debug line. A failed judge
call logs one line: a warning for the first failure since start or since the last success, then debug lines
until the judge answers again. The next turn gets the recalled notes once.
With the provider active, the adapter sets `LLMOS_MEMORY_INDEX_LOADED=1` for
`session-start`, so the index is not sent twice. Each profile's `llmos` MCP
server excludes its memory tools (`tools.exclude: ["memory_*"]`), so Hermes
sees one set. Hermes's built-in `memory` tool stays on for facts only Hermes
can act on. `llmos doctor` fails a profile without `memory.provider: llmos`
or without that exclude.

The stamp writes through the frontmatter serializer in `cli/src/frontmatter.ts`,
so block scalars, comments, and nested maps keep their data. A note without a
frontmatter block, with a block the serializer refuses, or with invalid UTF-8
is left unchanged. The stamp and reindex hooks share a session-scoped dirty
flag, so concurrent sessions never collide or leak a stale flag into each
other. A hook failure never blocks the tool call, and the hooks never import
qmd (it would cost about 48 ms per call). Embedding is left to a hand-run
`llmos reindex`; `llmos health` counts the documents that still
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

In a local session, `sync.ts` keeps `projects/<project>/memory/` the same on every host through the
vault's Git remote. It never rewrites the work tree: no `rebase`, `stash`, or
`reset`, and a dirty vault does not pause it. It builds every new commit
without the work tree (`git merge-tree --write-tree` and `git commit-tree`) and
moves `main` only with `git merge --ff-only`, which keeps unrelated edits and
refuses, rather than overwrites, a file that an incoming change overlaps.

The session-start hook fetches (4-second limit), then, when `HEAD` is behind
`origin/main` and not ahead, runs `git merge --ff-only origin/main` (4-second
limit) before it builds the context, so the injected `MEMORY.md` is fresh. Each
failure adds one line to the context: a failed fetch, a fast-forward that
refuses (with git's reason, without its `hint:` lines), or a rebase, merge, or
cherry-pick in progress. A diverged branch adds no line; Stop merges it. The
hook, like `llmos memory scope`, reads `MEMORY.md` only when it is a regular
file whose real path is inside the vault, so an index linked to a file outside
the vault is left out. The Stop hook uses local git commands to find changed
memory paths and commits ahead of `origin/main`. With neither, it never uses the network. Otherwise it
commits only the memory paths (other staged and unstaged edits stay) and
fetches (5 seconds). When behind only, it fast-forwards. When ahead and behind,
it merges the trees with `git merge-tree`, makes a merge commit with
`git commit-tree`, and fast-forwards to it (5 seconds); a conflict names the
conflicted paths and changes nothing on disk. It reads `HEAD` and `origin/main` once and uses
those commit IDs for every later step. Then it checks that each unpushed commit
and the net change touch only memory, and pushes that exact commit to `main`
(5 seconds). A skip or failure warns on stderr and leaves the commits local;
the next Stop retries because the branch is ahead. The Stop timeout is 30
seconds; the qmd reindex before the sync gets 10 of them, and a timed-out
reindex keeps its dirty flag for the next Stop.

A checkout syncs only when `LLMOS_NO_GIT_SYNC` is not `1`, the session is not a
cloud session, the vault is in a Git work tree with an `origin`, the branch is
`main`, and no rebase, merge, or cherry-pick is in progress. Sync work runs under
`<git-common-dir>/llmos-sync.lock`; a run that finds a fresh lock skips, and a
lock older than 60 seconds is taken over by an atomic rename, and a run
removes the lock only while it still holds that run's token. Set `LLMOS_NO_GIT_SYNC=1` to opt out.

Because a hook that cannot start fails silently, the session-start hook
records a heartbeat per agent in `${XDG_STATE_HOME:-~/.local/state}/llmos/hooks.json`
(time, Bun version, bundle SHA-256, plugin root), and `llmos doctor` fails
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
