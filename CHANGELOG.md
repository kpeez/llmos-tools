# Changelog — llmOS tools

Newest first. Versions are the `version` field shared by
`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`.antigravity-plugin/plugin.json`, and `cli/package.json`.

## Unreleased

- A vault note is now read through one checked path: `resolveInVault` in
  `cli/src/vault-file.ts` gives the branded `VaultFile` type, and `readText`
  accepts only that type. It refuses `..`, a link that leaves the vault, a
  link to a missing file, a folder, and any dot folder. The hook that adds
  `authoring.md` and `schema.md` to the agent's context no longer reads a
  note that links outside the vault. A Biome rule and a lint plugin ban the
  common raw reads (`readFileSync`, `readFile`, the `fs` default and namespace
  imports, `fs/promises`, `Bun.file`, `require("fs")`, and the cast
  `as VaultFile`) in the vault-handling modules; `AGENTS.md` lists the modules
  and what the rule does not cover: other modules, named `openSync`,
  `readSync`, and `createReadStream` imports, `Bun.mmap`, an alias of `Bun`,
  the cast `<VaultFile>p`, `any` passed as a `VaultFile`, `readSkillFile` in
  `docs.ts`, `readWalkedNote` (which follows links), and the PostToolUse stamp.
  A linked-out `authoring.md` or `schema.md` now gets the fallback line
  instead of its text. The project landing page and the daily
  note and template that the digest reads are now refused when they link
  outside the vault, and the digest reports that refusal as a normal error.
- Two agents that write one note at the same time no longer lose a change.
  `daily_append_thought`, `set_property`, `llmos set-property`,
  `llmos remove-property`, `llmos daily append-thought`, the property
  stamps, the PostToolUse stamp, the run records of `discover` and the
  nightly digest, and the digest's replace of the daily note's block now read,
  change, and write a note under one lock per vault. The lock is a kernel
  lock in the git common dir of the vault (the llmOS state folder when the
  vault is not a git checkout, or `git rev-parse` fails). Before, a probe with
  12 processes that appended 10 thoughts each kept 20 to 54 of 120. The
  digest's existence check of the note now runs inside the lock too. The
  PostToolUse stamp takes the lock once for all its notes and waits at most
  3 s; when the lock stays busy it skips the stamps and says so in its
  output. Obsidian takes no lock, so a save from Obsidian in the microseconds
  between the digest's second read and its rename is still lost.
- The memory project lock, the memory-sync lock, and the service start lock
  are now one lock: an exclusive SQLite transaction on a lock file
  (`cli/src/lock.ts`). The kernel gives it to one process and drops it when
  the holder exits or crashes, and no code removes a lock file. Before, the
  two lock files used a rename takeover after 30 s or 60 s. With three
  writers and a stale lock, two could hold it, and a link-back could restore
  a released lock, so memory saves failed for up to 30 s. The sync lock is
  `<git-common-dir>/llmos-sync.lock.db`. The memory lock of a project is
  `<git-common-dir>/llmos-memory-<key>.lock.db` when the vault is a git
  checkout, so every writer of that vault excludes the others, whatever its
  home or state folder. When the vault is not a git checkout, it is
  `locks/memory-<key>.db` in the llmOS state folder, and only writers that
  share that folder exclude each other. A writer whose `git rev-parse` fails
  (a timeout, a safe.directory refusal for another user, `GIT_DIR` set) also
  falls back to the state folder. Neither file is in the work tree, so
  no link in the vault can redirect it and no sync sees it. A lock path that
  is a symbolic link or not a regular file is refused. An old and a new
  plugin version that run at the same time do not exclude each other: they
  use different files.
- The hooks start faster. `pre-tool-use` and `guard-bash` run on almost every
  tool call, and they now have their own small bundle,
  `dist/pre-tool-use.js` (from `cli/src/hooks/pre-tool-use.ts`), with no YAML,
  memory, or vault-model code. `dist/hooks.js` serves `session-start`,
  `post-tool-use`, and `stop`. `hooks/hooks.json` and the Antigravity
  `hooks.json` name the bundle of each event, and the Hermes adapter runs the
  matching one. A Bash call now runs one hook process, not two:
  `pre-tool-use` also runs the guard for a shell tool, and a denial still
  wins (exit code 2, reason on stderr). The `guard-bash` event stays for the
  Hermes adapter.
- `llmos read` no longer loads the whole vault: it lists the vault, resolves
  the name as before, and reads only that note. Its output is unchanged. A note
  that cannot be read (for example invalid UTF-8) no longer makes `llmos read`
  of another note fail.
- A hook can write its output only through one `emit()` in
  `cli/src/hooks/runtime.ts`. A `HookResult` type names the result of each event,
  and `emit()` gives it the envelope that its harness reads. A Biome lint
  (`cli/lint/hook-channels.grit`) bans `process.stdout`,
  `Bun.stdout`, `process.cwd` (called or not), any use of the names
  `console` and `globalThis`, destructuring `stdout` or `cwd` from
  `process`, `Bun`, or a `require` of `process` or `bun`, and named imports
  of `stdout` or `cwd` from `process`, `node:process`, or `bun`, in
  `src/hooks/`, `src/mcp.ts`, and `src/memory.ts`, except in the hook entry
  points and `runtime.ts`. It
  does not catch a computed key such as `process["stdout"]`, an alias such
  as `const p = process`, a default or namespace import of `process`, a
  `require()` call that is not destructured, or an indirect read such as
  `process.env.PWD`, `path.resolve(".")`, or `fs.writeSync(1, ...)`.
  Only the entry points and `runtime.ts` read the process folder: they anchor a
  relative payload `cwd` there, as before. A relative `LLMOS_ROOT` is made
  absolute for the hooks by `absoluteVaultRoot()` in `src/root.ts`; the CLI
  still prints it as configured.
- `just release <major|minor|patch>` is now the only writer of the plugin
  version. It sets the four version fields (the three `plugin.json` files and
  `cli/package.json`) and dates the `## Unreleased` notes under the new
  version. `just release-check`, which `just check` and CI run, fails when the
  fields differ, when the version differs from `main` and the CHANGELOG has no
  heading for it, and in CI when a version change is in a pull request not
  titled `chore(release): ...`. It warns when shipped files changed since the
  last release and the version stayed the same.
- The session-start hook no longer stays silent when `LLMOS_ROOT` is set to a
  folder that is not a vault. It prints one context line that names the
  folder and says to fix `LLMOS_ROOT` or run `/setup-llmos`. Before, the agent
  worked with no vault and no warning. An unset `LLMOS_ROOT` still prints
  nothing.
- A failed `install.ts` no longer takes over `llmos` and `qmd`. The script
  linked `~/.local/bin/llmos` and `qmd` to the new copy before its smoke test,
  so a broken version left them on the broken copy while `current` stayed on
  the earlier version. The script now tests the new copy in place and links
  the commands only after it passes.
- The shared-memory sync merges a rename on one side with an edit on the
  other side again. Since the change that turned off rename detection in every
  git call, `git merge-tree` refused such a pair as a modify/delete conflict.
  The merge call now turns rename detection on. The name lists that check for
  private paths still never detect renames.
- `llmos daily activity --push` help no longer says the merge leaves the work
  tree alone: its fast-forward merge updates it. A new test fails when agent
  prose (docs, skills, `AGENTS.md`, hook text) names a repo path or an `llmos`
  command that does not exist. The docs now name the root `hooks.json`, the
  `provisionMemory` settings rewrite, all four heartbeat agents, and the
  doctor checks for the service, the memory collection, and Hermes.
- CI runs the TLA+ model checks in a new `models` job. `just verify-models`
  runs the same checks locally: each `.agents/skills/verify-*` skill that
  holds a `.tla` file. `bootstrap.sh` no longer links `.agents/skills` into
  `.claude/skills`; the repository now commits one link per skill.
- Concurrent `llmos service serve` starts can no longer leave two services
  running. The start lock was a pid file that a rival could read empty, judge
  dead, and remove while its creator still held it. Both starters then bound,
  and the orphaned service later deleted the live service's socket when it
  stopped. The start lock is now an exclusive SQLite transaction on
  `service.lock.db`, which the kernel releases when its holder exits or
  crashes, and `close()` no longer removes the socket path a second time.
  `just verify-llmos-service` model-checks the start rules with TLA+.
- Two agents that save or forget shared memories at the same time no longer
  lose `MEMORY.md` lines. `llmos memory save`, `llmos memory forget`, and the
  MCP memory tools now read and rewrite the index under a lock,
  a lock file in the llmOS state folder, and wait up to 10 s for it. Before, each
  write rewrote the index it had read, so a concurrent save dropped the other
  save's line and left its topic note out of the index, or failed with "a file
  already exists" on a new index.
- The Stop hook now reindexes after every vault write, so a keyword search
  finds the new text right after the turn. Before, only a Write or Edit that
  the stamp hook stamped set the dirty flag. The MCP tools
  `daily_append_thought`, `set_property`, and `file_inbox`, `llmos source add`,
  the other CLI write verbs, and a Write to a note without frontmatter left
  search stale until a later reindex. The flag is now one file per vault for
  all processes, in the private llmOS state folder
  (`~/.local/state/llmos/dirty/`), set by every headless write, source
  capture, and obsidian-cli write. It is never followed through a symbolic
  link. The hooks no longer leave a folder per session in the shared temp
  folder.
- Every git call goes through one module, `cli/src/git.ts`. It has no
  `pull`, `rebase`, `stash`, or `reset`, and every call has a timeout. Two
  Biome plugins (`cli/lint/`) fail on a git spawn outside it and on those
  words in any git argument list.
- `llmos daily activity --push` no longer runs `git pull --rebase
  --autostash` and a plain `git push`. A rebase that conflicted was aborted,
  and the abort dropped a memory commit that the Stop sync had made while
  HEAD was detached. The plain push also published every unpushed commit,
  private notes too. The digest now publishes the way the memory sync does:
  it fetches, merges without the work tree, and pushes one checked commit to
  `main`. It refuses while an unpushed commit touches anything but daily
  notes, its run record, and shared memory. The vault checkout must be on
  `main` with an `origin`.
- The cloud session-start hook no longer runs `git pull --rebase
  --autostash`, which left a rebase in progress on a conflict. It fetches and
  fast-forwards; a checkout with its own commits is left as it is, and the
  context says so. The context no longer tells the agent to run `git pull
  --rebase`: it says to fetch and fast-forward before editing, push to
  `main`, and stop and report when either refuses.
- The cloud session-start hook finds the vault checkout in the split layout.
  The vault root is now its own repository root, so the hook pulls `main` in
  the vault and links the repositories beside it. It scanned and pulled from
  the folder above the vault before.
- In a cloud session with no qmd index, the session-start hook starts a
  detached background build: it adds the vault as the `llmos` and `memory`
  collections and runs `llmos reindex --no-embed`. The hook does not wait. The
  context says that the search index is building, so `search` and
  `memory_search` work a minute or two later. The build writes its output to
  `llmos-index-build.log` in the temp folder. When `llmos` or `qmd` is not on `PATH`, the context
  says so and nothing starts.
- `llmos doctor` finds the plugin that the claude.ai account sync gives to
  Claude Code, as in a cloud session. The sync does not write
  `installed_plugins.json`. The doctor now also reads the
  `plugins/synced/<bucket>/manifest.json` files and takes the folder whose
  `plugin.json` names `llmos`. The `hooks` check no longer fails with "installed for neither"
  there.
- In a cloud session whose vault is not checked out yet, the session-start
  hook tells the agent to attach it with `add_repo`, clone it to
  `LLMOS_ROOT`, call `register_repo_root`, and run the hook again. Set
  `LLMOS_VAULT_REPO` (`owner/name`) in the cloud environment to turn it on.
  The user no longer attaches the vault by hand.

## 2.13.1 — 2026-11-22

- The post-tool-use hook tells the agent when a vault note's frontmatter is
  not valid YAML, such as `description: Rule: quote me` with an unquoted
  `: `. The finding (`invalid-frontmatter`) gives the path, the parser's line
  and column, and a hint to double-quote the value. It covers every vault
  note, shared memory notes included, which had no check before. The hook
  still leaves the note unchanged and never blocks the tool call.
- `llmos check` and the MCP `check` tool take no note to list every note in
  the vault whose frontmatter does not parse (exit 1 when there is one), so a
  tool that stops on one such note can be checked before it runs. With a
  note, `check` also reports the finding.

## 2.13.0 — 2026-11-21

- llmOS now uses `@tobilu/qmd` 2.9.0 (llama.cpp v0.9.0), so qmd can load
  Google's embeddinggemma-2 as its embed model.
- `llmos reindex` and the service's background embed rely on qmd's own embed
  lock. llmOS no longer writes `.qmd-embed.lock` itself, and a second embed
  fails with qmd's `EmbedLockBusyError` (the service still waits and retries).
- `llmos discover` reads qmd 2.9.0's per-collection vector table
  (`vectors_by_collection`).
- The first qmd command on an index after the upgrade converts the index in
  place. Going back to an older qmd needs `qmd embed -f`.
- Before you upgrade, stop every running `llmos service` and `llmos mcp`
  (restart agent sessions and the Hermes gateway). qmd 2.9.0 does not see
  the embed lock of an older llmOS, so an old process can embed at the same
  time as a new one.

## 2.12.2 — 2026-11-20

- `llmos discover` without `--out` writes its report to
  `<vault root>/artifacts/discover`, through the `artifacts` link the session
  hook makes, instead of `<vault root>/../artifacts/discover`, which pointed
  outside the checkout once the vault became the repository root. When the
  link is missing, it exits 2 and names the path; a real `artifacts/` folder
  inside the vault is still refused.
- `llmos file-inbox` and the MCP `file_inbox` tool no longer append a
  "Filed … from inbox" line under the daily note's `## Thoughts`; git records
  the move.
- The post-tool-use hook gives a shared memory topic note
  `metadata.node_type: memory` when the note lacks it, as `llmos memory save`
  and Claude Code write it. The pre-tool-use memory hint no longer asks
  agents for that field, so Claude Code agents stop re-adding a field that
  is already there.

## 2.12.1 — 2026-11-20

- The Hermes `llmos` memory provider's recalled notes now reach the next turn
  also when Hermes rebuilds the agent between turns, as it does after a turn
  that a fallback model served. The provider keeps them by profile and
  session, so two profiles in one gateway never share them.
- The session-start hook repairs a dangling `.agents/docs` link. When the link
  points at a folder that is gone (for example after the vault moves), the hook
  replaces it with a link to the folder it would link now, when that folder
  exists: in a worktree, the main checkout's target when that target exists,
  else `<root>/projects/<repo>`. The context names the repair. A worktree no
  longer inherits a main-checkout docs target that is gone. A dangling
  `.agents/scratch` or `artifacts` link is still left alone, because its disk
  may be unmounted.

## 2.12.0 — 2026-11-20

- 2.12.0 supersedes 2.11.1. The ADR removal (below) set the version fields to
  2.11.1 without a release section, so a host that installed main in between
  reports 2.11.1 for the same changes.
- The tools no longer know architecture decision records. The `proposed`, `accepted`, and
  `superseded` note statuses are gone from the schema check, and the skills and
  docs no longer mention ADRs or an `adrs/` folder. Decisions live in pull
  requests, commits, code, and each project's `CONTEXT.md`.
- The session-start hook and `llmos memory scope` read `MEMORY.md` only when it
  is a regular file whose real path is inside the vault, as vault writes
  already require. An index linked to a file outside the vault is left out of
  the session context and `index_text`, and `llmos memory save` and `forget`
  (and the MCP tools) refuse it before they write anything.
- The Hermes `llmos` memory provider now recalls shared memories. After each
  turn it pools, on a background thread, the scope's memories that share a
  word with the prompt and the top semantic hits (through the llmOS service
  when it runs). With `LLMOS_RECALL_JUDGE_URL` set, a decision model behind
  a SystemOne server judges the pool, keeps up to five helpful notes, and the
  next turn gets them once. `LLMOS_RECALL_JUDGE_MODEL` names the model
  (default `d1-2B`), and the threshold follows it: 0.5 for `d1-2B`, 0.3 for
  `clef-flash`. `LLMOS_RECALL_JUDGE_THRESHOLD` overrides it; a model with
  neither never calls the judge, and the provider logs one warning at start.
  `LLMOS_RECALL_JUDGE_TIMEOUT` bounds the whole call (default 5 seconds).
  Without the judge, or when it fails, recall is semantic-only (the first
  two hits that score at least 0.75), so a memory saved a moment ago is not
  found until it is embedded. Hermes shows the count in its recall line.
  Recall reads only regular files inside the vault: it skips a symbolic-link
  or non-UTF-8 note, and a memory folder that resolves outside the vault gets
  no recall. The provider now needs Hermes v2026.9.14 (0.21.3) or later.

- New llmOS service: one long-lived process per host that keeps the qmd search
  models loaded, so every agent session shares one warm model set. `llmos mcp`
  sends `search` and `memory_search` to it and starts it when it is down;
  `llmos search` and `llmos memory search` use it when it runs. A semantic search
  from a new client takes tens of milliseconds instead of a cold model load, and
  `llmos mcp` works as before when the service is down or cannot start. The
  service listens on a Unix socket in the llmOS state folder, stops after 30
  minutes without a request, and has `llmos service serve|status`. See
  `docs/service.md`; `LLMOS_SERVICE=off` turns it off.
- Memory search and background embedding use a new `memory` qmd collection
  (`projects/*/memory/*.md`). `llmos doctor` now reports the service, whether
  that collection exists (with the `qmd collection add` command that adds it),
  and how many memory notes lack an embedding. Until the collection exists,
  memory search uses the `llmos` collection as before. `llmos reindex` of
  `llmos`, which the Stop hook runs after a turn that changed the vault, also
  scans the `memory` collection, so memories that Claude Code writes, the
  memory sync pulls, or a person edits are found after the turn.
- `llmos memory save` and `forget` (and the MCP tools) update the keyword index
  at once, and a running service embeds the change in the background, so a
  semantic memory search finds a new memory without `llmos reindex`.
- `llmos memory search` now runs with `GGML_METAL_NO_RESIDENCY` set on macOS,
  as the other model-loading verbs do, so a semantic search no longer aborts at
  exit.

- Hermes Agent gets a memory provider, `llmos`. A profile that sets
  `memory.provider: llmos` gets the shared project memory index in its system
  prompt and the `memory_save`, `memory_search`, and `memory_forget` tools,
  which write the same notes as Claude Code. The project comes from the
  session's folder, else `personal`; subagent and cron sessions do not write.
  `llmos memory scope` now also prints `index_text`, the bounded index.
  `llmos doctor` fails a Hermes profile without `memory.provider: llmos`, or
  whose `llmos` MCP server still shows its memory tools; `setup-llmos` says
  how to set both.

- New `llmos memory scope|save|search|forget` verbs and MCP tools
  (`memory_save`, `memory_search`, `memory_forget`) read and write shared
  project memory (`projects/<project>/memory/`, ADR-0020) in the format Claude
  Code writes. A folder in a vault project's repository uses that project; any
  other folder uses `personal`. A save fails when `MEMORY.md` would pass 200
  lines or 25,000 bytes. Codex approves `memory_search` and asks before the
  other two. The session-start context names the memory tools and the project
  to pass them. Without a `project` argument, the MCP tools take the session's folder
  from the client's first root, `CLAUDE_PROJECT_DIR`, or the launcher's
  starting folder, and fail when none names it, so a save never lands in
  `personal` by accident. The `llmos memory` CLI defaults to the current
  folder; `--project` or `--workspace` overrides it.
- A cloud session's start context now loads `personal` memory, not the
  `llmos` project's, when the session is not in a vault project. A session
  inside the vault still loads `llmos` memory.

## 2.11.0 — 2026-11-18

- `install.ts` points `~/.local/share/llmos/current` at each new install, as its
  last step. Hermes Agent links its plugin and skills through `current`, so it
  runs an installed copy, not a checkout, and `llmos-doctor` fails a Hermes
  profile that links outside `~/.local/share/llmos/`. `setup-llmos` and
  `docs/hooks.md` name the `current/` paths.
- `llmos-doctor` fails `hooks-hermes` when `~/.hermes/plugins/llmos` links to
  a folder that is gone, such as the vault's old `tools/hermes`, and checks
  each Hermes profile then too. It used to report Hermes as not installed.
- `setup-llmos` says to run `hermes gateway restart` after you repoint the
  Hermes plugin link.
- The CLI is now one command, `llmos`. No alias is kept, so change every
  caller: `llmos-vault <verb>` becomes `llmos <verb>`, `llmos-doctor` becomes
  `llmos doctor`, `llmos-audit` becomes `llmos audit`, and
  `llmos-daily-activity` becomes `llmos daily activity`. The old commands are
  gone. `install.ts` links only `llmos` and `qmd`.
- The marketplace is now `llmos-tools`, and the plugin ID is
  `llmos@llmos-tools`. On each host, remove the `llmos-vault` marketplace and
  its plugin, add `kpeez/llmos-tools`, and install `llmos@llmos-tools`. Approve
  the Codex hooks again, because Codex records hook trust by plugin ID. Then
  delete the old `~/.local/bin/llmos-*` links and rerun `install.ts`.
- Update every agent config that names an old command: the Hermes MCP
  `command` and `command_allowlist`, the Claude permissions, and the foxlab
  systemd unit.
- `llmos doctor` has a new `old-names` check. It fails on any such config
  line and names the file and line. It ignores the vault repository name
  `kpeez/llmos-vault` and the unit names `llmos-daily-activity.service` and
  `llmos-daily-activity.timer`.

## 2.10.1 — 2026-11-18

- The tools now live in their own repository, `kpeez/llmos-tools`, with the
  plugin at the repository root. The marketplace keeps the name `llmos-vault`;
  re-add it from `kpeez/llmos-tools` to keep receiving updates. CI, the
  marketplace catalogs, `bootstrap.sh`, and the verify skills use the new
  layout.
- The daily activity digest reads the GitHub owners it monitors from
  `github_owners` in `~/.config/llmos/config.json`, and fails when the list
  is missing or empty. The code no longer names them. Add the key on the
  host that runs the digest timer before you update its install.
- The rules that the code enforces ship with the tools: the source manifest,
  the compiled-fact and conflict formats that `claims lint` reads
  (`docs/compiled-facts.md`), and the ingest contract
  (`docs/ingest-contract.md`). `consolidate-knowledge` uses paths from the
  vault root, so it works when the vault is the root of its own repository.
- `maintain-llmos` says what to do when `daily append-thought` cannot reach
  Obsidian: report the thought in the reply instead of writing the note by
  hand. The digest timer docs describe the schedule as owned by the host.
- `--vault` takes the folder name of any vault in Obsidian's registry, not
  one fixed second vault. `llmos` still means the llmOS vault.
- `llmos-vault config set-root` keeps the other keys of the config file.
- Hermes Agent runs the llmOS hooks. The adapter plugin in `hermes/` maps
  Hermes hooks to `dist/hooks.js`: session context on the first turn, the
  vault guard on `terminal`, read context and frontmatter stamps on the file
  tools, and the Stop work at the end of each turn. `llmos-doctor` checks
  `hooks-hermes`, and setup-llmos says how to wire each Hermes profile.
- The Hermes adapter sends the agent back before it finishes while a vault
  note it changed is not committed and pushed (`pre_verify`, at most twice).
- `llmos-doctor` checks every Hermes profile (`hermes-profile-<name>`): the
  MCP server, the llmOS skills, the enabled plugin and its link, and the vault
  rules in `SOUL.md`.

## 2.10.0 — 2026-11-18

- Notes no longer get an `authors` property (ADR 0014). The PostToolUse hook,
  the MCP write tools, `file-inbox`, `discover`, and the digest stamp only
  `updated`. The schema audit no longer checks `authors`, and the Reviews and
  Daily Reviews Bases no longer show it. Existing values stay until a script
  removes them from the vault. An older plugin still adds the property, so
  update every host before that cleanup.
- `set-property <note> authors <value>` writes a plain value. The list
  properties are `categories`, `project`, and `topics`.

## 2.9.1 — 2026-11-18

- The Stop hook gives the qmd reindex 10 s of its 30 s budget, so a slow
  reindex no longer crowds out the memory sync. A timed-out reindex keeps its
  dirty flag for the next Stop and skips the `qmd update` fallback.
- Sync warnings drop git's `hint:` lines, and the sync docs describe the fixed
  commit IDs and the net-change check.

## 2.9.0 — 2026-11-17

- Every host sees the same shared project memory (`projects/<project>/memory/`)
  through the vault's Git remote, and the sync never damages a vault you are
  editing. It never rebases, stashes, or resets, and a dirty vault does not
  pause it: it builds each new commit without the work tree (`git merge-tree`,
  `git commit-tree`) and moves `main` only with `git merge --ff-only`, which
  refuses rather than overwrites. The session-start hook runs
  `git fetch origin main` (4 s limit), then fast-forwards when behind
  (4 s limit) before it builds the context; a refusal adds one context line (a
  rebase, merge, or cherry-pick in progress is named too). The Stop hook finds
  work with local git commands only. When memory files changed, or commits are
  ahead of `origin/main`, it commits only the memory paths, fetches (5 s),
  fast-forwards or merges (5 s; a conflict warns and changes nothing on disk),
  and pushes the checked commit to `main` (5 s); with no work it never uses the network. A skip
  or failure warns on stderr, and the next Stop retries it. A lock file in the
  git common dir (`llmos-sync.lock`, owner token, stale after 60 s, atomic
  takeover) makes concurrent runs skip. Sync runs only for a local vault
  checkout on `main` with an `origin`. Set `LLMOS_NO_GIT_SYNC=1` to opt out.
- The Stop hook timeout is 30 s in `hooks/hooks.json` and `hooks.json`
  (it was 15 s).

## 2.8.1 — 2026-11-07

- The session-start hook links a vault project's agent folders in every
  session, local or cloud, and in every git worktree:
  `.agents/docs` to `<root>/projects/<repo>`, `.agents/scratch` to
  `~/agent-scratch/<repo>/`, and `artifacts` to `~/artifacts/<repo>/`. The
  repository name comes from the main checkout, so a worktree folder's name
  no longer picks the vault folder. A worktree reuses a link target of the
  main checkout. The hook never replaces a path that exists, and it adds
  each link to the `info/exclude` file that all worktrees share. A
  repository without a vault project folder gets no link and no note.
  A link that fails adds a note and does not stop the other links.

## 2.8.0 — 2026-10-28

- `source add` captures PDFs: a PDF file, a URL that serves a PDF, or an
  arXiv paper without an HTML version. It writes `raw.pdf`, the figure
  crops in `assets/`, and the text in `source.md`. MinerU converts the PDF
  on this machine (`--tier advanced --disable-image-analysis`), and the
  manifest's `converter` names its version. Install MinerU on each host that
  captures PDFs: `uv venv ~/.mineru`, then
  `uv pip install --python ~/.mineru "mineru>=4.0,<5"`, and set
  `LLMOS_MINERU` to `~/.mineru/bin/mineru-kit`. Without MinerU, a PDF
  capture fails and says how to install it; web captures do not need it.
- `source add` takes `--licence` for a PDF that does not state its
  licence, and `--origin` for the URL that a PDF file came from.
- When defuddle keeps less than a tenth of a long page's visible words,
  `source add` runs it again on the page's article container. On a bioRxiv
  full-text page, defuddle had kept only the reference list. When no
  container holds at least a tenth of the words, the capture keeps
  defuddle's text and prints a warning.
- `set-property` and the MCP `set_property` tool add a value to
  `categories`, `project`, and `topics` as a list item, as they already did
  for `authors`. Before, they wrote a string, and the schema audit refused
  the note. To replace one of these lists, remove the property first.

## 2.7.0 — 2026-10-26

The vault has a new layout (ADR 0013).
An older install reads and writes the old paths, so update the plugin and
run `bun <llmos-plugin-root>/cli/scripts/install.ts` on every host before
its next daily digest. Then run `llmos-vault reindex`.

- Daily notes are in `daily/`, not `reviews/daily/`.
- Captured sources are in `raw/<slug>/`, not `sources/<slug>/`.
  `source add` writes there, and `claims lint` accepts a source link only
  to `raw/<slug>/source`.
- The inbox is every note in `raw/` except a capture's
  `raw/<slug>/source.md`. `health` lists those notes under `stale_inbox`.
  The inbox hub note `inbox/Inbox.md` is gone. A plain vault
  (another `--vault`) keeps `inbox/`.
- `schema.md`, `authoring.md`, and `ingest-contract.md` are at the vault
  root, not in `agents/references/`. The hooks and the MCP server name the
  new paths.
- Note templates are in `categories/templates/`, and the Bases are in
  `categories/` beside their hubs. The digest builds a new daily note from
  `categories/templates/daily-note.md`.
- `file-inbox` files into `knowledge`, `projects`, or `raw`. It stamps
  `[[Sources]]` only on a capture's `raw/<slug>/source.md`; any other note
  in `raw/` gets no category. The `archive` area is gone: an archived project stays in `projects/<slug>/` with
  `status: archived`.
- `discover` skips the root rule notes and the captured sources, and it
  keeps the inbox notes in `raw/` as candidates.
- The CLI names the vault's folders in one module, `cli/src/layout.ts`.

## 2.6.1 — 2026-10-22

- The CLI's Bun project (`package.json`, `bun.lock`, `src/`, `bin/`,
  `test/`, `scripts/`, `justfile`) moved from the plugin root to `cli/`.
  Claude Code installs the dependencies of a plugin whose root holds a
  `package.json` and a lockfile, devDependencies included, and Claude Desktop
  does not copy a plugin with the symbolic links of `node_modules/.bin/` to an
  SSH host. So hosts reached over SSH from Claude Desktop had no `llmos`
  plugin. The plugin cache now gets no `node_modules`.
- Install the CLI with `bun <llmos-plugin-root>/cli/scripts/install.ts`. The
  install still copies the plugin root to `~/.local/share/llmos/<version>/`,
  and its `~/.local/bin` links now point into `cli/`. The MCP launcher
  accepts installs of both layouts.
- Run `bun` and `just` commands for the CLI from `tools/cli/`.
- A local-folder marketplace (`plugin marketplace add <checkout>`, as
  `bootstrap.sh` registers) still copies gitignored files into the plugin
  cache. Remove `tools/node_modules`, which the move leaves stale, and any
  `tools/cli/node_modules` from such a checkout before the plugin update, or
  use the GitHub source on hosts that Claude Desktop reaches over SSH.

## 2.6.0 — 2026-10-15

- `check` and the PostToolUse authoring check report a hard-wrapped
  paragraph or list item (`hard-wrapped-paragraph`). Obsidian shows every
  single newline as a line break, so agents that wrapped prose at 80 columns
  wrote notes that read as ragged broken lines. Block quotes, callouts,
  tables, code, hard line breaks, and the digest's `llmos-activity` block
  keep their lines.
- In a cloud session (`CLAUDE_CODE_REMOTE=true`), the vault is an attached
  repository: the cloud's GitHub proxy serves only attached repositories, so
  a vault cloned by a setup script cannot push. The session-start hook pulls
  `main` into the attached checkout, links `.agents/docs` in every repository beside it, and
  tells the agent to push vault notes to `main`, not the session branch. A
  session whose working folder holds several repositories also gets the
  vault context.
- New `scripts/bootstrap.sh` sets up a host from a checkout in one command.
  It installs the CLI, sets the vault root to `<checkout>/llmOS`, installs
  the `llmos` plugin for Claude Code and Codex when they are on `PATH`, runs
  `llmos-doctor`, and prints the steps that need a person. It keeps a root,
  marketplace, or plugin that is already configured.

## 2.5.1 — 2026-10-13

- The daily activity digest calls `github-copilot/claude-haiku-5.5`. The
  OpenCode Go subscription behind `opencode-go/deepseek-v4-flash` lapsed, and
  every nightly run from 2026-10-08 to 2026-10-12 failed with a 403.
- A failed `opencode run` now reports opencode's error event. opencode prints
  that error on stdout, so the journal used to show only
  `opencode run failed:` with no reason.
- The digest records each successful run without `--date` as `digested:
  YYYY-MM-DD` on `categories/Reviews.md`. `health` lists `daily-activity`
  under `overdue_jobs` when that date is missing, invalid, more than 1 day
  in the future, or more than 3 days old. `set-property`, `remove-property`, and `create` refuse that
  property, as they refuse `discovered`.
- `llmos-daily-activity --push` commits only the notes the run wrote and the
  run record, rebases on the upstream, and pushes. The digest timer passes
  it, so the digest reaches every host without a manual commit.
- `tools/.tool-versions` pins Bun 1.4.3 for local builds and CI. `just hooks`
  fails when `bun` is another version, because the committed bundles must
  match CI's build.

## 2.5.0 — 2026-10-10

- Narrow reads, so agents need not read whole notes to answer small questions.
  - `read --section HEADING` prints only the text under one heading, its
    subsections included. A heading that is missing or named twice is an
    error that lists the note's headings.
  - `read --properties-only` and `list --properties-only` leave out the body.
  - `list --folder PATH` keeps only the notes under one vault-relative folder.
  - The MCP `read` tool takes `section` and `properties_only`. A new MCP
    `list` tool returns the properties of every note under a required
    `folder`; it leaves out notes linked out of the vault.
- The session-start hook now routes agents to the MCP tools before `Grep` and
  `Read`, by task: `search` to find notes, narrow `read` and `list` for
  properties or one section, `neighbors` and `subgraph` for links. Before, it
  only preferred the tools over the CLI, and agents almost never called them.

## 2.4.3 — 2026-10-09

- `discover` no longer counts an embed of an existing file (`![[Reviews.base#Project]]`,
  an image) as a dangling link. Before, the project landing notes shared
  their Base embeds as dangling links and ranked first as one 16-note cluster
  that restated no work.

## 2.4.2 — 2026-10-08

- `source add` writes an image whose whole alt text is one bracketed phrase,
  as arXiv's `[Uncaptioned image]` is, as a plain Markdown image
  (`![Uncaptioned image](url)`), not as `![[Uncaptioned image]](url)`. Obsidian
  and `health` read the old form as an unresolved embed. Existing captures are
  frozen and keep the old form.

## 2.4.1 — 2026-10-08

- `health` reports fewer false positives, and the schema audit drops a dead rule.
  - A wikilink or embed that names an existing non-note file (`![[Topics.base#Topic members]]`,
    an image) resolves by its vault-relative path, then by its file name,
    ignoring a `#fragment`. The vault model now lists the non-note files for
    this. A file that does not exist stays unresolved.
  - A `[[...]]` inside a fenced code block (``` or ~~~, also unclosed) or an
    inline code span is no link, in `health`, `neighbors`, `check`, and every
    other command that reads links. Code spans follow CommonMark: a backslash
    escapes an opening backtick, a span closes only at a backtick run of the
    same length, and it never crosses a blank line or a heading.
  - Files in dot folders such as `.trash/` are not vault notes or link targets,
    as `.obsidian/` already was. A note inside `.trash/` no longer loads.
  - The MCP server's warm vault reloads when an image or other non-note file
    is added or removed, not only when a note changes.
  - In the llmos vault, `inbox/Inbox.md`, the inbox folder's hub note, is never
    a stale inbox item and never an orphan.
  - An orphan is a note that no other note links to and that has no valid
    category. A `categories` link that names a hub in `categories/` counts,
    because the hub's Base lists the note. So a daily note filed under
    `[[Reviews]]` is never an orphan, and an unfiled one is.
  - `health` (and the MCP `health` tool) now reports `orphans`, `dead_ends`,
    and the `referrer` of each unresolved link as vault-relative paths with
    `.md` (`projects/a/README.md`), not as file names. Many notes share a file
    name, so a name did not say which note it meant. This changes the JSON
    values and the text summary.
  - In the llmos vault, a note with a valid category and the inbox hub are not
    orphans. A plain vault (another `--vault`) counts backlinks only.
  - In the llmos vault, a note in the root `templates/` folder is no orphan and
    no dead-end. An unresolved link from it is skipped only when its target is a
    placeholder, a target with `{{` and `}}` (such as `{{title}}.base` or
    `{{date:YYYY-MM-DD}}`). A template that links a real missing note still
    reports it. A link from a template resolves its target, but does not count
    as an inbound link, so a note that only a template links to stays an orphan.
    Folders named `templates` elsewhere are checked like any note. A plain
    vault reports templates as before.
  - The schema audit no longer skips `archive/specs/`, a folder the vault
    deleted. Notes under `archive/` are audited like any other note.

## 2.4.0 — 2026-10-08

- New `llmos-vault discover [--top N] [--out DIR] [--no-record]` ranks
  clusters of notes that restate the same works, as candidates for
  `consolidate-knowledge`. Signals: shared arXiv ids and DOIs, shared dangling
  links, shared `topics` without a topic note, and qmd similarity from the
  vectors already in the index (no model loads; without an index it skips the
  signal and says so). A cluster whose notes already link one `knowledge/`
  note reports `covered_by` and ranks after the uncovered ones. It writes the
  JSON report to `<vault root>/../artifacts/discover/YYYY-MM-DD.json` and never
  writes inside the vault.
- `discover` is a manual job. Each run of the llmos vault sets
  `discovered: YYYY-MM-DD` on `categories/Knowledge.md` and sets `updated`
  there, in one atomic write. It adds the agent to `authors` only when it
  detects an agent harness. The record travels with the vault. `--no-record`
  skips it. Before any work, `discover` runs the same edit without writing and
  fails when that note is missing, is a symbolic link, or has frontmatter that
  the edit cannot rewrite. It writes nothing else in the vault.
  In the llmos vault, `set-property`, `remove-property`, and the MCP
  `set_property` refuse the `discovered` property of that note, also through
  a link to it; `create` refuses new content for it that sets the property.
- `health` has a new `overdue_jobs` section (llmos vault only, also in the MCP
  `health` tool). `discover` is overdue, and `health` exits 1, when the
  `discovered` date is missing, is not a valid `YYYY-MM-DD` date, lies more
  than 1 day in the future (time-zone skew), or is more than 10 days old.
- `discover` excludes `archive/` notes and reports dangling links and missing
  topics as counts. It ignores an edge of low weighted overlap
  (`MIN_OVERLAP`), so a note that cites many works no longer bridges
  unrelated clusters. A symbolic link planted at the report path no longer
  carries the write into the vault.
- `discover` reads identifiers more strictly. A DOI ends at the first
  character outside Crossref's suffix set and loses trailing punctuation and
  publisher page suffixes (`/full`, `/abstract`, `/pdf`, `/epdf`). The URL
  escapes of `/ ( ) : ; < >` are decoded. A DOI followed by `<` or `>` (SICI
  and AMS forms) is dropped; a `<https://doi.org/...>` autolink is kept. Text
  inside a wikilink never joins a DOI. A dated bioRxiv or medRxiv DOI keys on
  its date and number; another bioRxiv DOI loses its `.full`, `.abstract`,
  or `.supplementary-material` suffix and its version. An arXiv id must have the digit count and year range
  of its date.
- `llmos-doctor` warns about an unreadable heartbeat time instead of printing
  "NaN days ago".
- `llmos-vault check` also reports Markdown that makes Obsidian render a note
  wrongly: `table-column-count`, `empty-link`, `reversed-link` (markdownlint
  rules MD056, MD042, MD011), and `table-wikilink-pipe`, an unescaped alias
  pipe in a table wikilink that splits the cell (write `[[target\|label]]`).
  Notes under `sources/` and dot folders are skipped. The PostToolUse hook and
  the MCP `check` tool report them too. Adds the `markdownlint` dependency.

## 2.3.2 — 2026-10-08

- New `consolidate-knowledge` skill. It takes one cluster of related notes and
  writes the topic hub, plus paper and dataset notes whose facts quote
  captured sources, in a worktree on `claude/consolidate-<slug>`. It lints the
  facts, runs a second check in separate Claude subagents (a per-note fact
  prompt and a hub-prose prompt, in `references/`), checks privacy, and
  delivers the run as a draft pull request with fact counts by status and
  an estimated review time. A run over 30 minutes of review splits into
  smaller pull requests.
- The schema audit rejects a `categories` value that is not the exact plain
  name of a hub in `categories/`, such as `[[Paper]]` or
  `[[categories/Papers|Papers]]`.
- The schema audit rejects the retired `repositories` property.
- `file-inbox` no longer stamps `[[Archive]]` when filing into `archive/`;
  no such hub exists.
- `source add` points Markdown images at their downloaded copies with a
  single forward scan instead of a regular expression that took quadratic
  time on text such as `![a](` repeated (13.7 s for 200 KB; now about 15 ms).
  The result is the same, except that an image that starts inside another
  match's target is now also rewritten.
- New `llmos-vault claims lint <notes...> [--json]` checks the `[!fact]` and
  `[!conflict]` callouts of knowledge notes: each quote must occur in the
  linked heading's section of its captured source, and each number of a fact
  must occur in its quote (with `%`, `±`, signs, exponents, and attached identifiers). A quote needs
  at least 6 words, and the source's `sha256_text` is recomputed. Any finding
  exits 1; flagged
  facts are reported without failing, and superseded facts are skipped. The
  format is now in `docs/compiled-facts.md` and the conflict rule in
  `docs/ingest-contract.md`.
- A command's last argument can now take several values (`<paths...>`).

## 2.3.1 — 2026-10-08

- `llmos-vault source add <arxiv-id|url|inbox-note>` captures an arXiv
  paper (from `arxiv.org/html/<id>`, pinned to the version fetched) or a web
  page into `sources/<slug>/`: `raw.html`, the images of the captioned
  figures in `assets/`, and `source.md` with the defuddle text and a manifest
  in its frontmatter. A source that is already captured is not fetched
  again. A PDF, or an arXiv paper without HTML, exits 1 and stays in the
  inbox. Requests go only to public http and https hosts, with at most five
  redirects, each hop checked; no body over 50 MB; figure images must be `image/*`.
- New `ingest-source` skill, which sorts inbox items and runs `source add`.
- The vault's `.gitattributes` stores `sources/**` raw pages, PDFs, and
  assets in Git LFS.
- New dependencies: `defuddle` 0.19.4 (text extraction), with `linkedom`
  0.18.13 as its DOM and `turndown` 7.2.0 for Markdown.
- `package.json` now carries the plugin version (it said 0.2.0).

## 2.3.0 — 2026-10-07

- Retire the Python implementation (ADR 0012): delete the
  `llmos_vault` package, its pytest suite, the unwired Python hooks, the
  source-checkout shims (`scripts/audit_metadata.py`, `doctor.sh`,
  `vault_root.py`, `write_daily_activity.py`), `pyproject.toml`, and
  `uv.lock`. No installed command changes: every host already runs the Bun
  CLI and hooks.
- Committed contract snapshots in `test/contract/` replace the differential
  harness and the digest parity check. They pin the CLI's JSON output and
  exit codes (except `list`'s exit code), the canonical `normalize` output,
  and the schema audit on the fixture vaults (now in `test/fixtures/`) and
  the generated edge vault, and the digest's outcomes, block hashes,
  markers, and notes on the digest edge days. They were recorded while Python was still the reference and checked
  against it; where TypeScript intentionally differs, the snapshot holds the
  TypeScript output and names the allowlist entry it replaces. `just
  contract-record` records them again after an intended contract change.
- The real-vault differential run becomes a TypeScript-only invariant check
  (`just invariants <vault-copy>`): every note reads, `normalize` refuses no
  valid YAML, keeps every value, and is idempotent.
- `scripts/gen-marketplaces.py` is now `scripts/gen-marketplaces.ts`, with
  byte-identical catalogs. CI and `just check` run Bun only; the `ts-types`,
  `ts-lint`, and `ts-test` recipes are now `types`, `lint`, and `test`.
- `scripts/install.ts` no longer replaces links into the retired
  `llmos-vault` uv tool, and the `setup-llmos` skill no longer covers
  removing that tool.

## 2.2.0 — 2026-10-07

- The canonical note writer keeps Markdown hard line breaks: a body line
  with content that ends in two or more spaces keeps that run of spaces when
  a note is stamped or normalized. It still trims a single trailing space,
  trailing tabs, other trailing whitespace, and lines of only whitespace, and
  the frontmatter block's canonical form is unchanged. The Python writer
  (frozen) still trims them; the differential allowlist lists this as an
  intended difference (`body-hard-line-break`).
- The activity digest's completeness check requires each PR and issue to be
  linked with its repository and number (a `github.com/OWNER/REPO/pull/N` or
  `/issues/N` URL, as the prompt asks), not just `#N`. Before, one `#N`
  counted for every repository with that number that day, and `#4` counted
  as found inside `#45`. The prompt now lists each required link with its
  URL. The block hash and markers are unchanged; the digest parity check
  compares the required links, reduced to their numbers, with Python's `#N`
  list.

## 2.1.0 — 2026-10-07

Codex hooks must be approved again: `hooks/hooks.json` gains a PreToolUse
matcher.

- Fix the activity digest hiding a newly opened PR when a PR with the same
  number merged that day in another repository. A merged PR now hides only
  itself (same repository and number). On such a day the block and its hash
  differ from the Python digest's; the digest parity check expects exactly
  this difference.
- Remove `src/compat.ts`, the layer that copied Python string, path, and date
  behavior (ADR 0012 as amended). Internal code now uses native TypeScript
  and Bun behavior; the canonical frontmatter writer keeps Python's
  whitespace set, line breaks, and code-point key order, because the on-disk
  form is part of the contract. Visible effects: `check`, `health`, and
  `llmos-audit` messages quote values as JSON (`"x"`, was `'x'`); an inbox
  note whose `created` is not `YYYY-MM-DD` (such as `20261005` or
  `2026-W40-3`) now counts as stale; lists sort by UTF-16 code unit, which
  differs from code-point order only between astral characters and
  U+E000–U+FFFF; a caller-typed note path and a `file-inbox` destination are
  normalized, so `a/../b` means `b`. The differential allowlist lists the
  first two as intended differences.
- `file-inbox` refuses a destination outside the vault with the vault-escape
  error before it checks the filing area.
- The schema audit finds new (untracked) notes with non-ASCII names; git's
  path quoting hid them before. A link property value ending in a newline is
  no longer a wikilink, and `created` must use ASCII digits.
- Add the plugin-declared `llmos` MCP server (ADR 0012, MCP phase):
  `llmos-vault mcp` on stdio, built on the official TypeScript MCP SDK
  (`@modelcontextprotocol/server` 2.0.0, the version qmd already installs).
  Read tools `read`, `neighbors`, `subgraph`, `check`, `health`, `search`;
  write tools `daily_append_thought`, `file_inbox`, `set_property`, which
  stamp `updated` and `authors` on the notes they change. Each tool runs the
  matching command's handler and takes its help. One vault model stays
  loaded and is read again when a note file changes; the qmd search models
  stay loaded after the first semantic search. Only the llmOS vault is
  served, and every note must resolve inside the real vault root.
- Claude Code starts it from `.mcp.json` and Codex from `.codex-mcp.json`,
  through the bundled launcher `dist/mcp.js`, with Bun's project `.env`,
  `bunfig.toml`, and auto-install off. Without an installed CLI the launcher
  serves a single `setup` tool. Codex runs the read tools without a prompt
  and asks before each write tool.
- The PreToolUse hook gives the MCP write tools the note schema and the
  authoring contract, under Claude Code's and Codex's tool names; the
  SessionStart context names the MCP tools.
- `llmos-doctor` gains an `mcp-server` check that starts the server and
  lists its tools.
- Changed: `llmos-vault search --semantic` is now vector search with the
  embedding model (about 0.8 s on an M-series Mac), not qmd's hybrid pipeline. The new
  `--hybrid` flag runs the full pipeline (query expansion, keyword and vector
  retrieval, reranking; 13 to 22 s per query with the models loaded). The
  MCP `search` tool takes `semantic` and `hybrid` the same way.

## 2.0.0 — 2026-10-07

Breaking: the plugin hooks, the `llmos-vault` CLI, and the activity digest now
run on Bun. Each host needs `bun` on the hook `PATH` and a CLI install through
`setup-llmos`; Codex hooks must be approved again.

- Port the `llmos-vault` CLI, `llmos-doctor`, and `llmos-audit` to TypeScript
  on Bun (ADR 0012, CLI phase). Command names, flags, JSON output shapes, and
  exit codes are kept. `set-property`, `remove-property`, `append`,
  `daily append-thought`, `create` without a template, and the stamping step
  of `file-inbox` are now atomic file writes that work with Obsidian closed;
  only `move` and `create --template` need the app (exit 3 without it). Writes
  never leave the vault, also not through symbolic links.
- New verbs: `search` (qmd keyword search, `--semantic` for hybrid search)
  and `reindex` (qmd update, embed, and cleanup), through the qmd SDK pinned
  at `@tobilu/qmd` 2.8.3. `health` reads its qmd index gaps the same way.
- `setup-llmos` installs the CLI with `scripts/install.ts` into
  `~/.local/share/llmos/<version>/` and links `llmos-vault`, `llmos-doctor`,
  `llmos-audit`, `llmos-daily-activity`, and the pinned `qmd` into
  `~/.local/bin/`.
  `llmos-vault config set-root` replaces `write_config.py`. `llmos-doctor`
  fails unless exactly one `qmd` is on `PATH` and it is this install's.

- Add the TypeScript core in `src/` (ADR 0012, first phase): frontmatter on
  the `yaml` Document API that keeps block scalars, comments, and nested maps;
  one vault model for reads and the link graph; root resolution with a typed
  error; and the llmOS-profile reads. A differential harness compares it with
  the Python CLI, and CI runs the Bun checks beside the Python ones. The
  installed commands are unchanged.
- Port the daily activity digest to `src/digest.ts` (ADR 0012). For the same
  `gh` output it writes the same block hash, markers, and note as the Python
  digest; `test/differential/digest.ts` checks this. Unlike the Python
  digest, it runs the model as an opencode agent with every tool denied, it
  writes `<!--` from the model or a project title as `&lt;!--` so no marker
  can appear inside the block, and it refuses a note whose markers are not
  one start and one end.
- Run the plugin hooks from one Bun bundle, `dist/hooks.js` (ADR 0012, hooks
  phase), instead of Python scripts. Hosts need `bun` on the hook `PATH`, and
  Codex needs the changed hooks approved again. The stamp hook now keeps block
  scalars, comments, and nested maps instead of skipping those notes. The
  stop hook updates only the keyword index (`llmos-vault reindex --no-embed`,
  else `qmd update -c llmos`) and never embeds; run `llmos-vault reindex` by
  hand to embed, and `llmos-vault health` reports `qmd_unembedded`.
- The session-start hook records a heartbeat per agent in
  `${XDG_STATE_HOME:-~/.local/state}/llmos/hooks.json`, and `llmos-doctor`
  fails for an agent whose installed hooks have not run (no `bun` on the hook
  `PATH`, or untrusted Codex hooks) and warns after 7 days.

## 1.2.0 — 2026-10-07

- Move into the `kpeez/llmos` repository as `tools/`, beside the vault; the
  former tools repository is retired. Marketplace catalogs move to the
  repository root and point at `./tools`; the marketplace keeps the
  `llmos-vault` name, so the plugin ID stays `llmos@llmos-vault`.
- `llmos-doctor` targets Obsidian by the vault folder's name instead of a
  fixed `llmOS`.

## 1.1.0 — 2026-10-01

- Recognize linked project documentation at startup and inject retrieval or
  authoring guidance for supported reads and writes after resolving symlinks.
- Deliver the vault's canonical Obsidian authoring contract for Markdown,
  Bases, and Canvas work; keep knowledge and syntax guidance discoverable
  through the existing skills.
- Add `llmos-vault check` and post-write feedback for unlinked references to
  existing notes, with body links reported separately from frontmatter links.
- Document per-host Codex and Claude activation, current hook trust, fresh
  session verification, and the limits of tool-call coverage.

## 1.0.6 — 2026-09-25

- Retire spec handling now that the vault holds no specs: the audit skips the
  `archive/specs/` deletion queue, a `specs/` folder no longer earns its own
  rules, inbox filing no longer stamps `[[Specifications]]`, and
  `llmos-audit --fix`, which only stamped specs, is removed.
- The daily activity digest derives each active project's repository from its
  folder name across the monitored GitHub owners instead of reading a
  `repositories:` allowlist; a name found under two owners is a hard failure.
- Replace the nightly closeout and weekly synthesis docs, which never ran, with
  the digest's systemd user timer.

## 1.0.5 — 2026-08-30

- Move the plugin and `llmos-vault` uv tool into the standalone `llmos-vault`
  repository with independent marketplace catalogs, CI, and package checks.
- Package all four maintenance commands while retaining source-checkout
  compatibility shims.
- Align the setup doctor with the canonical `AGENTS.md` vault sentinel.
- Keep failed qmd reindexing retryable with a non-blocking diagnostic.

## 1.0.4 — 2026-08-01

- Make hook commands fish-safe: `${CLAUDE_PLUGIN_ROOT}` becomes
  `"$CLAUDE_PLUGIN_ROOT"`, matching the swe plugin's fix — Codex runs hooks
  through the login shell, where fish rejects `${VAR}` as a syntax error.
- Add the nightly daily-activity digest script: scans monitored projects,
  gates on a content hash, summarizes with one pinned non-interactive OpenCode
  Go call, and writes the digest atomically.
- Update setup tests for the renamed install script and generated
  marketplace catalogs.

## 1.0.3 — 2026-07-17

- Add the `llmos_vault` Python package and the llmos-vault CLI: headless
  read/list verbs, a wikilink graph (neighbors, subgraph), mutation verbs
  (create, move, append, set/remove property) through an obsidian-cli write
  backend, and a vault health report covering orphans, dead-ends, unresolved
  links, schema violations, stale inbox, and qmd gaps.
- Add the `/vault-cli` router skill and generate the command reference docs
  from the CLI tree.
- Register vault hooks: a PreToolUse Bash guard for obsidian-cli targeting
  and vault mv/rm/git-rm, a PostToolUse hook that normalizes frontmatter and
  stamps authors/updated, and a Stop hook that reindexes qmd when dirty.
- Consolidate on one canonical frontmatter serializer; fix list-property
  corruption, mv/rm guard false positives, and bare-basename resolution.
- Add llmOS-profile daily-note helpers and file-inbox filing verbs.
- Skill-quality pass across `/maintain-llmos` and `/setup-llmos`.

## 1.0.2 — 2026-07-17

- Retire the daily-branch model from the plugin.
- Give the Codex hook-trust gate an owner in `/setup-llmos`; stop the
  SessionStart injection asserting a digest that is never built.

## 1.0.1 — 2026-07-16

- Deliver the note contract through the SessionStart injection — the only
  channel a model actually reads — naming the daily note by absolute path.
- Retire the receipt channel and both dead hook symlinks in setup;
  point `/maintain-llmos` at the daily note instead of receipts.
- Cover the metadata-audit seam moved by ADR-0007; drop stale Project Logs
  validation.

## 1.0.0 — 2026-07-16

- Initial release: scaffold the llmOS plugin and migrate core components —
  the `/maintain-llmos` and `/setup-llmos` skills, session hooks
  (`llmos_hook.py`), scripts for metadata audit, daily branches, vault-root
  resolution, daily receipts, and a doctor check, plus their test suite.
