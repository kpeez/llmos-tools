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

`hooks/hooks.json` wires four lifecycle events to two files that `bun build`
bundles from `cli/src/hooks/`. It runs from the plugin cache with no install
step and needs only `bun` on the hook `PATH`. The same command form serves
Claude and Codex: each entry names its event on the command line, and the JSON
payload arrives on stdin. The `hooks.json` at the repository root is the
Antigravity copy: it holds the same commands under Antigravity's tool names,
and Antigravity finds it at the plugin root.

- `dist/pre-tool-use.js` (from `pre-tool-use.ts`) serves `pre-tool-use` and
  `guard-bash`. Both run on almost every tool call, so the bundle holds only
  the path resolution and the guard: no YAML, memory, or vault-model code.
  Bun loads a bundle before it runs, so a small bundle starts faster.
  `dist/shell-grammar.js` holds the shell parser (`unbash`) and its check. The
  guard loads it only when a command names `mv`, `rm`, `find`, or
  `obsidian-cli`. When that
  bundle fails to load, the guard falls back to its older token check. The
  grammar check reads at most 20,000 entries of a folder; a larger folder counts
  as holding a note, so the guard denies the call (it fails closed). It skips
  dot folders (`.trash`) and `node_modules`, and it approves a plain `rm`, `mv`, or
  `git rm` of a symbolic link to the vault when the path has no trailing slash,
  because that removes only the link. `find` and a command that lists paths for
  `xargs` follow the link, so the guard denies them.
- `dist/hooks.js` (from `main.ts`) serves `session-start`, `post-tool-use`,
  and `stop`.

```sh
bun --no-env-file --config=/dev/null "$CLAUDE_PLUGIN_ROOT"/dist/pre-tool-use.js pre-tool-use
bun --no-env-file --config=/dev/null "$CLAUDE_PLUGIN_ROOT"/dist/hooks.js <event>
```

A Bash call runs one process, not two. For a shell tool (`Bash`,
`run_command`), `pre-tool-use` computes the vault context and runs the guard.
A denial wins: exit code 2 with the reason on stderr (Antigravity: a `deny`
decision). The context goes to stdout as before. A failure of one part never
hides the other. The `guard-bash` event stays for a caller that sends only
shell commands (the Hermes adapter).

The two flags stop Bun from loading the session's project `.env` and
`bunfig.toml` (whose `preload` scripts would otherwise run in every hook).

| Event                    | Hook event      | Source        | Purpose                                                                                                     |
| ------------------------ | --------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| SessionStart             | `session-start` | `session-context.ts`, `cloud.ts`, `links.ts` | Links a vault project's agent folders, then supplies vault context inside the vault and repositories with linked vault docs; in a cloud session, first fast-forwards the vault checkout to `origin/main` and links each attached repository; in a local session, first fetches and fast-forwards the vault's shared memory (`sync.ts`) |
| PreToolUse (reads/edits) | `pre-tool-use`  | `context.ts`  | Resolves target paths, supplies retrieval context on reads and the authoring contract before writes          |
| PreToolUse (MCP writes)  | `pre-tool-use`  | `context.ts`  | Supplies the schema and authoring contract before `daily_append_thought`, `file_inbox`, and `set_property` |
| PreToolUse (Bash)        | `pre-tool-use` (the guard part) | `guard.ts`    | Denies `obsidian-cli` note verbs without `file=`/`path=` and raw `mv`/`rm`/`find -delete` of vault notes, also inside wrappers, `bash -c`, and `$( )` (exit 2, reason on stderr) |
| PostToolUse (Write/Edit) | `post-tool-use` | `stamp.ts`    | Normalizes and stamps frontmatter, reports authoring findings, and sets the dirty flag for every vault note the tool wrote, stamped or not; gives a shared memory topic note `metadata.node_type: memory` when it lacks it, and leaves memory notes otherwise unstamped and unchecked, except that every vault note, memory notes included, gets a finding when its frontmatter is not valid YAML |
| Stop                     | `stop`          | `stop.ts`, `sync.ts` | Updates the keyword index **iff** the dirty flag is set, by this turn or by any other process: `llmos reindex --no-embed` (the `llmos` collection, and `memory` when it exists), else `qmd update -c llmos` (qmd scans every collection); never embeds. Then commits changed shared project memory and pushes it |

## Hermes Agent

Hermes Agent does not read `hooks/hooks.json`. The adapter plugin in
`hermes/` (Python, standard library only) runs the same bundles: `dist/pre-tool-use.js`
or `dist/hooks.js` for each Hermes hook, sends the payload the bundle reads for Claude Code
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
it cannot resolve, gets no recall and one debug line; a folder it cannot list
gives no notes. A failed judge call logs one line: a warning for the first
failure since start or since the last success, then debug lines until the
judge answers again. The next turn gets the recalled notes once, also when
Hermes rebuilds the provider between turns, and never in another profile.
With the provider active, the adapter sets `LLMOS_MEMORY_INDEX_LOADED=1` for
`session-start`, so the index is not sent twice. Each profile's `llmos` MCP
server excludes its memory tools (`tools.exclude: ["memory_*"]`), so Hermes
sees one set. Hermes's built-in `memory` tool stays on for facts only Hermes
can act on. `llmos doctor` fails a profile without `memory.provider: llmos`
or without that exclude.

The stamp writes through the frontmatter serializer in `cli/src/frontmatter.ts`,
so block scalars, comments, and nested maps keep their data. A note without a
frontmatter block, with a block the serializer refuses, or with invalid UTF-8
is left unchanged. When a vault note's frontmatter block is not valid YAML, in
any folder and memory notes included, the hook also adds an
`invalid-frontmatter` finding to its context: the vault-relative path, the
file line, the parser's line and column in the block, and a hint to
double-quote a value that contains `: `. A site build such as Quartz stops on
such a note. The hook still leaves the note unchanged, and the finding never
blocks the tool call. `llmos check` with no note lists these notes across the
vault. A block the serializer refuses for another reason, such as an empty
list item, gets no finding.

Every vault write sets the vault's dirty flag, `dirty/<vault hash>` in the
llmOS state folder (`$XDG_STATE_HOME/llmos`, else `~/.local/state/llmos`;
`cli/src/dirty.ts`): the headless writes of the CLI and the MCP write tools
(`cli/src/write.ts`), a `llmos source add` capture, an obsidian-cli move or
create, and the stamp hook for a harness's own Write or Edit. The flag is not
per session, because an MCP server or CLI process does not know the session
and every session shares the index. So the next Stop of any session
reindexes. The flag holds a token. The Stop hook clears the flag only after a
successful reindex, and only when the token is unchanged, so a write during
the reindex keeps the flag for the next Stop. The flag's folder must be owned
by the user and not writable by group or others, or the flag is not used. The
flag is written to a new `0600` file and renamed into place, and read with
`O_NOFOLLOW`, so a symbolic link at its path is replaced, never followed.
Writes that bypass these paths do not set it: a Bash command, the Obsidian
app, a memory sync pull, and the daily digest's own daily-note write. A hook
failure never blocks the tool call, and the hooks never import qmd (it would cost about 48 ms per call).
Embedding is left to a hand-run `llmos reindex`; `llmos health` counts the
documents that still need it.

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
target folder. It never replaces a path that exists, with one exception: a
dangling `.agents/docs` link (a symlink whose target is gone, as after the
vault moves) is replaced when its new target folder exists, and the context
says so. The new target is the one the hook would link now: in a worktree,
the main checkout's target when that target exists, else
`<root>/projects/<repo>`. A worktree does not reuse a main checkout target
that is gone. The hook never redirects a dangling scratch or artifacts link,
because its disk may be unmounted. It adds each link it makes or repairs to
`<git-common-dir>/info/exclude`, which all worktrees share, not to the
repository's `.gitignore`. The vault's own repository gets no
`.agents/docs`. The context names each link made; a session that makes none
adds nothing. A link that fails adds one note that names the link and the
error, and the other links are still made.

The hook runs only at session start, only for the session's project folder,
and only for repositories whose `<root>/projects/<repo>` exists. A worktree
made later in a session gets no links from it; the next session started in
that worktree links it.

In a cloud session (`CLAUDE_CODE_REMOTE=true`), the vault is an attached
repository, checked out beside the session's code repositories (for example
`/home/user/llmos-vault` and `/home/user/agent-toolbox`). The cloud's GitHub proxy
serves only attached repositories, so this is how a cloud session can push
vault notes. The session-start hook first fetches `origin main` into the vault
checkout (6-second limit) and fast-forwards it there with `git merge
--ff-only` (2-second limit). It never rebases: a checkout with commits that
are not on `origin/main` is left as it is, and the context says so. Then it
links each repository beside the vault checkout the same way. The context
tells the agent the same safe flow: before it edits vault notes, `git fetch
origin main` and `git merge --ff-only origin/main`; then commit and push to
`main` (`git push origin HEAD:main`), not to the session branch. When the
fast-forward refuses, the agent stops and reports. When the push refuses, it
fetches, runs `git merge --no-edit origin/main` (a fast-forward or a merge
commit, never a rebase), and pushes once more; after a merge conflict (it runs
`git merge --abort`) or a second refusal, it stops and reports. The 6-second
fetch limit is the one that the single `pull` had before the fetch and the
fast-forward were two calls. With the 2-second fast-forward limit and 1 s for
the local calls, it fits in the session-start deadline (10 s less the 0.5 s
reserve). A failed fetch or fast-forward is reported in the
context. A fresh checkout has no qmd
index, so the hook also starts a detached build when the index file is missing:
it adds the `llmos` and `memory` collections with `qmd collection add`, then
runs `llmos reindex --no-embed`. The
hook does not wait for it, and `search` works a minute or two later. The build
writes its output to `llmos-index-build.log` in the temp folder. When
`llmos` or `qmd` is not on `PATH`, the context says so instead. The cloud environment
sets the vault root with `LLMOS_ROOT`, and the claude.ai account syncs the
plugin. The hook does neither.

When `LLMOS_ROOT` does not exist yet in a cloud session and
`LLMOS_VAULT_REPO` names the vault repository (`owner/name`), the hook tells
the agent to attach it: call `add_repo` for that repository, clone it to
`LLMOS_ROOT`, call `register_repo_root`, then run the session-start hook again.
The second run gives the vault context and starts the index build. Only an
attached repository accepts a push through the cloud's GitHub proxy, so the
agent attaches the vault instead of cloning it with a token.

When `LLMOS_ROOT` is set but names no vault, and the attach case above does not
apply, the hook prints one context line. The line quotes the path and names the
case: the path does not exist, it is not a folder, or it is a folder that lacks
`.obsidian/` or `AGENTS.md`. It says to point `LLMOS_ROOT` at the vault or run
`/setup-llmos`. The path is quoted as a JSON string, so a newline in it cannot
add a line to the plain-text context. With `LLMOS_ROOT` unset, the hook stays silent.

In a local session, `sync.ts` keeps `projects/<project>/memory/` the same on every host through the
vault's Git remote. Like every git call in the hooks and the CLI, it runs git
through `cli/src/git.ts`, which offers no `rebase`, `stash`, `reset`, or
`pull`; a Biome plugin fails on any other git spawn. It never rewrites the
work tree, and a dirty vault does not pause it. It builds every new commit
without the work tree (`git merge-tree --write-tree` and `git commit-tree`) and
moves `main` only with `git merge --ff-only`, which keeps unrelated edits and
refuses, rather than overwrites, a file that an incoming change overlaps.

The session-start hook fetches (4-second limit), then, when `HEAD` is behind
`origin/main` and not ahead, runs `git merge --ff-only origin/main` (4-second
limit) before it builds the context, so the injected `MEMORY.md` is fresh. Each
failure adds one line to the context: a failed fetch, a fast-forward that
refuses (with git's reason, without its `hint:` lines), or a rebase, merge, or
cherry-pick in progress. A diverged branch adds no line; Stop merges it. The
session-start hook, like `llmos memory scope`, reads `MEMORY.md` only when it
is a regular file whose real path is inside the vault, so an index linked to a
file outside the vault is left out. The Stop hook uses local git commands to
find changed memory paths and commits ahead of `origin/main`. With neither, it
never uses the network. Otherwise it commits only the memory paths (other
staged and unstaged edits stay) and fetches (5 seconds). When behind only, it
fast-forwards. When ahead and behind,
it merges the trees with `git merge-tree`, makes a merge commit with
`git commit-tree`, and fast-forwards to it (5 seconds); a conflict names the
conflicted paths and changes nothing on disk. It reads `HEAD` and `origin/main` once and uses
those commit IDs for every later step. Then it checks that each unpushed commit
and the net change touch only memory, and pushes that exact commit to `main`
(5 seconds). A skip or failure warns on stderr and leaves the commits local;
the next Stop retries because the branch is ahead. The Stop timeout is 30
seconds. The reindex runs before the sync, and each of its calls gets 10
seconds: `llmos reindex --no-embed`, then `qmd update` when the first call
fails without a timeout. So the reindex can use 20 seconds. A timed-out
reindex keeps the dirty flag for the next Stop. Each hook also has a deadline
for all its subprocesses together: its `hooks.json` timeout less half a
second (`src/hook-limits.ts`). Near the deadline a call gets only the time left, and later calls
are skipped. A cloud session start that runs out of time says how many
repositories it did not link.

A checkout syncs only when `LLMOS_NO_GIT_SYNC` is not `1`, the session is not a
cloud session, the vault is in a Git work tree with an `origin`, the branch is
`main`, and no rebase, merge, or cherry-pick is in progress. Sync work runs under
`<git-common-dir>/llmos-sync.lock.db`, an exclusive SQLite transaction (the
kernel lock of `cli/src/lock.ts`); a run that finds it held skips. The kernel
drops the lock when its holder exits or crashes, so no run removes a lock
file. Set `LLMOS_NO_GIT_SYNC=1` to opt out.

Session start also provisions shared project memory for a vault project
(`provisionMemory` in `links.ts`). It creates `projects/<slug>/memory/` in the
vault and rewrites the project's `.claude/settings.local.json` to set
`autoMemoryDirectory` to that folder. It keeps the file's other keys, skips a
file that is not a JSON object, and keeps the file out of Git.

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
