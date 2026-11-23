# Agent instructions

This repository is the `llmos` agent plugin. Its `cli/` folder is the llmOS CLI,
written in TypeScript and run by Bun.

The project documents, such as the glossary, live in the vault,
not here. Reach them through `.agents/docs`, a link to the vault's
`projects/llmos/` folder: `ln -s <vault root>/projects/llmos .agents/docs`.
Git ignores the link.
Run every command from `cli/`; the paths below are relative to it. The
marketplace catalogs live at the repository root and point at it.

Keep `package.json` and `bun.lock` in `cli/`, never in the plugin root.
Claude Code installs the dependencies of a plugin whose root holds a
`package.json` and a lockfile, and Claude Desktop does not copy a plugin with
the symbolic links of `node_modules/.bin/` to an SSH host. A test fails when
the plugin root holds a `package.json`.

The external contract is what agents, skills, and the vault read: the
canonical frontmatter on disk, CLI names, flags, JSON shapes, and exit
codes, hook output channels, and the digest markers and block hash. Internal
code uses native TypeScript and Bun behavior. Committed snapshots in
`test/contract/snapshots/` pin the CLI results, the canonical `normalize`
output, and the schema audit on the fixture vaults and a generated edge
vault, and the digest's outcomes, block hashes, markers, and notes on the
digest edge days; `bun test` compares the output with them. The hook tests
in `test/hooks/` pin the hook output channels. Change a snapshot only for an
intended contract change: record it with `just contract-record` and review
the diff in the pull request.

The `llmos` CLI is a command registry (`src/commands.ts`, run by
`src/cli.ts`; entry points in `bin/`). Its contract is the command names,
flags, JSON output shapes, and exit codes (3: Obsidian not running), plus
the canonical frontmatter form on disk. Handlers return results and never
print or exit, so other front ends can call them. After changing a command's
help, run `bun bin/llmos.ts docs`; a test fails while the vault-cli
reference is stale.

`Context.fetch` is the network seam of `source add`: tests pass a fetcher
that replays the recordings in `test/fixtures/web/` (or in-memory pages) and
never touch the network.

A hook writes its output only through `emit()` in `cli/src/hooks/runtime.ts`,
which gives each event the envelope its harness reads. Hook, MCP, and memory
code never writes to a console or to stdout, and never reads the process folder
to find its scope. A Biome lint (`cli/lint/hook-channels.grit`) fails on `process.stdout`,
`Bun.stdout`, `process.cwd` (called or not), any use of the names `console`
and `globalThis`, destructuring `stdout` or `cwd` from `process`, `Bun`, or a
`require` of `process` or `bun`, and named imports of `stdout` or `cwd` from
`process`, `node:process`, or `bun`. It does not catch a computed key such as
`process["stdout"]`, an alias such as `const p = process`, a default or
namespace import of `process`, a `require()` call that is not destructured, or
an indirect read such as `process.env.PWD`, `path.resolve(".")`, or
`fs.writeSync(1, ...)`. It applies to `src/hooks/`, `src/mcp.ts`, and
`src/memory.ts`, except the hook entry points (`main.ts`, `pre-tool-use.ts`)
and `runtime.ts`.

Never point a manual run or a test at the real qmd index
(`~/.cache/qmd`): set `INDEX_PATH`, `QMD_CONFIG_DIR`, and `XDG_CACHE_HOME`
to a temporary folder, as `test/helpers.ts` `isolatedEnv` does.

After a change to a command's behavior, the MCP server, or the hooks
(`src/`, `../dist/`, `../hooks/`), also run `just verify-llmos`. It drives the
real CLI, the MCP server, and the hook bundle on a scratch copy of a fixture
vault, and keeps the evidence in `../artifacts/verify-llmos/<timestamp>/`.
The `verify-llmos` skill (`../.agents/skills/verify-llmos/`) holds the
feature map and says which commands cannot run without Obsidian.
After a change to how the digest or anything else writes daily notes
(`src/digest.ts`, `src/daily.ts`, `src/write.ts`), also run `just
verify-daily-digest`. It model-checks with TLA+ that the digest never deletes
text written to a note during its model call. The `verify-daily-digest`
skill (`../.agents/skills/verify-daily-digest/`) says what the model
covers and how to read a failure.
Run git only through `src/git.ts`. It sets a timeout and path-safe options
on every call and offers no `rebase`, `stash`, `reset`, or `pull`, which can
drop a commit that another writer made. Two Biome plugins in `lint/` fail on a
git spawn anywhere else and on those words in any git argument list.
Start subprocesses only through `src/run.ts` (`run`, `start`, `startDetached`).
Its options require `timeoutMs`, and a Biome plugin (`lint/subprocess.grit`)
fails on `Bun.spawn`, `Bun.spawnSync`, `Bun.$`, and `node:child_process` in any
other file. A hook arms one deadline for all its subprocesses
(`src/hook-limits.ts`, armed in `runHook` in `src/hooks/runtime.ts`); `run` cuts each call to
the time left. `test/hooks/manifest.test.ts` fails when a hook's deadline plus
its reserve reaches its `hooks.json` timeout. Never give a hook call a limit
below the one it had before: the deadline is the bound.
After a change to `src/git.ts`, the shared-memory sync, or anything else that
runs git in the vault checkout (`src/hooks/sync.ts`, `pushNotes` in
`src/digest.ts`), also run `just verify-memory-sync`. It model-checks with TLA+ the rules that
the sync never reverts remote or local work, never pushes a private note,
and lets one run at a time hold its lock. The `verify-memory-sync` skill
(`../.agents/skills/verify-memory-sync/`) lists the known findings it
expects and how to read a failure.
`just verify-models` runs every model check: each `../.agents/skills/verify-*`
skill that holds a `.tla` file runs the `check.ts` script in its `scripts/`
folder. CI runs it in the `models` job, so a new model skill is gated with no
workflow change.
Claude Code finds each repository skill through its committed link
`../.claude/skills/<skill>` (to `../../.agents/skills/<skill>`). A new skill
commits its own link.
After a change to how the llmOS service starts or stops (`withStartLock`,
`serveService`, or `close()` in `src/service.ts`, or `servicePaths` in
`src/service-client.ts`), also run `just verify-llmos-service`. It
model-checks with TLA+ that concurrent starts, stops, and crashes leave one
reachable service. The `verify-llmos-service` skill
(`../.agents/skills/verify-llmos-service/`) says what the model covers.

Take every lock through `src/lock.ts`: an exclusive SQLite transaction that
the kernel drops when its holder exits or crashes. It refuses a lock path
that is a symbolic link. A `HeldLock` frees its lock when it is garbage
collected, so keep the reference until `release()`. Never write a lock file
that code must judge stale or remove. Keep a lock file out of the vault work
tree. A note write that reads, changes,
and replaces a note runs in `withNoteLock` (`src/write.ts`). Change it only with
`just verify-memory-sync`, `just verify-llmos-service`, and `just verify-daily-digest`.

Preserve unrelated working-tree changes. Changes here go through a pull
request so CI runs. Tests use the fixture vaults in `test/fixtures/`, never
the real vault (`$LLMOS_ROOT`); point `LLMOS_ROOT` at a temporary vault for a
live probe.

Before declaring a change complete, run the relevant `just` recipes. The full
local gate is `just check` (after `bun install --frozen-lockfile`); it runs the
marketplace drift check, the type check, Biome, and `bun test` (with the
contract snapshot tests), and it fails when a committed bundle
(`../dist/hooks.js`, `../dist/pre-tool-use.js`, `../dist/shell-grammar.js`, or
the MCP launcher `../dist/mcp.js`) is stale. It does
not run the model checks; CI runs them (`just verify-models`). After changing
`src/hooks/`, `src/mcp-launcher.ts`, or core code they import, run `just
hooks` and commit the rebuilt bundles. The hooks that run on every tool call
(`pre-tool-use`, `guard-bash`) have their own entry point and bundle
(`src/hooks/pre-tool-use.ts`): keep YAML, memory, and vault-model code out of
its imports, because Bun loads the whole bundle on every tool call. `.tool-versions` pins the Bun version for
local builds and CI (`bun-version-file`); `just hooks` refuses another `bun`,
because a bundle built by another version differs from CI's. To move Bun,
change that file and the `@types/bun` version in `package.json` together. Changing `../hooks/hooks.json` means
every host must approve the Codex hooks again.

A vault note is read through one door. `resolveInVault(root, relative)` in
`src/vault-file.ts` is the only constructor of the branded `VaultFile` type:
the real path of a regular file inside the real vault root, with no dot
folder (`.trash/`, `.obsidian/`) in its path. It refuses `..`, an absolute
path, a link that leaves the vault, a link to a missing file, and a folder.
`readText` takes only a `VaultFile`, and the note writes of `write.ts` take
one from `resolveInVault`. Two Biome checks (`../biome.json`) guard the door in
`vault.ts`, `write.ts`, `memory.ts`, `schema.ts`, `digest.ts`, `daily.ts`,
`authoring.ts`, `health.ts`, `mcp.ts`, `commands.ts`, and `src/hooks/context.ts`.
`noRestrictedImports` bans `readFileSync`, `readFile`, `promises`, and a
default or namespace import of `node:fs` and `fs`, and all of `node:fs/promises`
and `fs/promises`. The `lint/vault-reads.grit` plugin bans `Bun.file`,
`require("fs")` and `require("node:fs")` (with or without `/promises`), and
the cast `as VaultFile`. Not covered:

- Every module outside that list. They read files that are not vault notes
  (config, state, install, the other hooks) or take outside paths on purpose.
  `sources.ts` is one: its capture of a URL note goes through `resolveInVault`,
  but the module also reads outside files, so nothing stops a new raw read there.
- Other ways to read or to forge a `VaultFile`: named `openSync`, `readSync`,
  and `createReadStream` imports from `node:fs`; `Bun.mmap`; an alias such as
  `const B = Bun; B.file(p)`; the angle-bracket cast `<VaultFile>p`; and a
  value of type `any` passed as a `VaultFile`.
- `readSkillFile` in `src/docs.ts`: an exported raw read of any path, kept for
  the `docs` command and outside the rule.
- `readWalkedNote(root, relative)`: it refuses `..` and an absolute path, but it
  follows a symbolic link out of the vault, as Obsidian does (the `read`
  command contract). It is for paths that `walkVault` listed.
- The PostToolUse hook (`src/hooks/stamp.ts`), which checks the files a tool
  just wrote wherever they are.

The Hermes provider (`hermes/`, Python) keeps its own containment code.

The MCP server (`src/mcp.ts`, `llmos mcp`) takes its arguments from a
model: keep every tool's arguments checked in its handler, every path inside
the real vault root through `vault-file.ts` (`resolveInVault`) or `write.ts`,
and add no shell or arbitrary-file tool. Claude Code reads `../.mcp.json`, Codex `../.codex-mcp.json`, and
Antigravity (`agy`) `../mcp_config.json`; keep the Bun flags
`--no-install --no-env-file --config=/dev/null` in all of them, so a session's
project cannot load code or config into the server.

To check the frontmatter invariants on the real vault (every note reads,
`normalize` refuses no valid YAML, keeps every value, and is idempotent),
copy the vault to a directory outside it and pass the copy: `just
invariants <copy>`. Write any report (`bun test/contract/invariants.ts
--report FILE <copy>`) to `../artifacts/`. Never point it at the live vault.

Never choose a release's version level yourself. The owner picks it. Ask the
user whether the release is major, minor, or patch, then run `just release
<level>`. That recipe is the only writer of the `version` in
`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`.antigravity-plugin/plugin.json`, and `cli/package.json`, and it dates the
CHANGELOG `## Unreleased` notes under the new version. Never edit those fields
by hand. `just release-check` (in `just check` and in CI) fails when the four
fields differ, when the version differs from `main` and the CHANGELOG has no
heading for it, and, in CI, when the version changes in a pull request not
titled `chore(release): ...`. It warns when shipped files changed since the
last release and the version stayed the same: hosts cache the plugin by
version, so a change reaches them only after a release.

Marketplace catalogs (`../.claude-plugin/marketplace.json`,
`../.agents/plugins/marketplace.json`) are generated by
`scripts/gen-marketplaces.ts` (`just gen`) and must stay in sync with the
plugin manifest.
