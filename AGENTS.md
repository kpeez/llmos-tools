# Agent instructions

This repository is the `llmos` agent plugin. Its `cli/` folder is the llmOS CLI,
written in TypeScript and run by Bun. Run every command from `cli/`; the paths
below are relative to it.

The project documents, such as the glossary, live in the vault, not here.
Reach them through `.agents/docs`, a link to the vault's `projects/llmos/`
folder: `ln -s <vault root>/projects/llmos .agents/docs`. Git ignores the link.

Keep `package.json` and `bun.lock` in `cli/`, never in the plugin root.
Claude Code installs the dependencies of a plugin whose root holds a
`package.json` and a lockfile, and Claude Desktop does not copy a plugin with
the symbolic links of `node_modules/.bin/` to an SSH host. A test fails when
the plugin root holds a `package.json`.

## Work and verify

Every change goes through a pull request, so CI runs. Preserve unrelated
working-tree changes.

Tests and probes use the fixture vaults in `test/fixtures/`, never the real
vault (`$LLMOS_ROOT`). For a live probe, point `LLMOS_ROOT` at a temporary
vault. Never point a run at the real qmd index (`~/.cache/qmd`): set
`INDEX_PATH`, `QMD_CONFIG_DIR`, and `XDG_CACHE_HOME` to a temporary folder, as
`test/helpers.ts` `isolatedEnv` does.

Before you call a change complete, run each recipe that matches it:

| Change | Run |
| --- | --- |
| Any change | `just check` (after `bun install --frozen-lockfile`) |
| `src/hooks/`, `src/mcp-launcher.ts`, or core code they import | `just hooks`, and commit the rebuilt bundles |
| A command's help | `bun bin/llmos.ts docs` |
| A command's behavior, the MCP server, or the hooks (`src/`, `../dist/`, `../hooks/`) | `just verify-llmos` |
| How the digest or anything else writes daily notes (`src/digest.ts`, `src/daily.ts`, `src/write.ts`) | `just verify-daily-digest` |
| `src/git.ts`, `src/lock.ts`, or other code that runs git in the vault checkout (`src/hooks/sync.ts`, `pushNotes` in `src/digest.ts`) | `just verify-memory-sync` |
| How the service starts or stops (`withStartLock`, `serveService`, or `close()` in `src/service.ts`; `servicePaths` in `src/service-client.ts`) | `just verify-llmos-service` |
| `withNoteLock` in `src/write.ts` | all three model recipes above |
| An intended contract change | `just contract-record`, and review the snapshot diff in the pull request |

`just check` runs the marketplace drift check, the type check, Biome,
`bun test` with the contract snapshot tests, `just release-check`, and a check
that the committed bundles (`../dist/hooks.js`, `../dist/pre-tool-use.js`,
`../dist/shell-grammar.js`, and the MCP launcher `../dist/mcp.js`) are current.
It does not run the model checks.

`just verify-llmos` drives the real CLI, the MCP server, and the hook bundles
on a scratch copy of a fixture vault, and keeps the evidence in
`../artifacts/verify-llmos/<timestamp>/`. Its skill
(`../.agents/skills/verify-llmos/`) holds the feature map and says which
commands cannot run without Obsidian.

Each model recipe checks a TLA+ model. Its skill in `../.agents/skills/`
says what the model covers, which known findings it expects, and how to read a
failure. `just verify-models` runs every `verify-*` skill that holds a `.tla`
file, through the `check.ts` script in its `scripts/` folder. CI runs it in
the `models` job, so a new model skill needs no workflow change. Claude Code
finds each repository skill through its committed link
`../.claude/skills/<skill>` (to `../../.agents/skills/<skill>`); a new skill
commits its own link.

To check the frontmatter invariants on the real vault (every note reads,
`normalize` refuses no valid YAML, keeps every value, and is idempotent), copy
the vault to a folder outside it and run `just invariants <copy>`. Write any
report (`bun test/contract/invariants.ts --report FILE <copy>`) to the
repository's `artifacts` folder. Pass only the copy, never the live vault.

## Contract

The external contract is what agents, skills, and the vault read: the
canonical frontmatter on disk, the CLI command names, flags, JSON output
shapes, and exit codes (3: Obsidian not running), the hook output channels,
and the digest markers and block hash.

- Committed snapshots in `test/contract/snapshots/` pin the CLI results, the
  canonical `normalize` output, and the schema audit on the fixture vaults and
  a generated edge vault, and the digest's outcomes, block hashes, markers,
  and notes on the digest edge days. `bun test` compares the output with them.
  Change a snapshot only for an intended contract change.
- The hook tests in `test/hooks/` pin the hook output channels.
- The CLI is a command registry (`src/commands.ts`, run by `src/cli.ts`; entry
  points in `bin/`). Handlers return results and never print or exit, so other
  front ends can call them. A test fails while the vault-cli command reference
  differs from the registry.
- `Context.fetch` is the network seam of `source add`. Tests pass a fetcher
  that replays the recordings in `test/fixtures/web/` (or in-memory pages) and
  never touch the network.

## One door per risk

Each risky operation has one module. A Biome lint or a type makes the other
ways fail, and each lint's message names the door. The "Not caught" lists are
the known gaps.

### Git: `src/git.ts`

Run git only through `src/git.ts`. It sets a timeout and path-safe options on
every call and offers no `rebase`, `stash`, `reset`, or `pull`, which can drop
a commit that another writer made.

- `lint/git-spawn.grit` fails on a git spawn outside `src/git.ts`. It also
  fails on the string `"git"` bound to a variable or an object property
  (`const GIT = "git"`, also wrapped in `as`, `satisfies`, or parentheses).
- `lint/git-words.grit` fails on those four verbs, `--rebase`, and
  `--autostash` in any array or call argument list under `cli/`, tests
  included.
- Not caught: a plain template string such as `` `git` ``, a ternary
  (`c ? "git" : "x"`), a later assignment (`let a; a = "git"`), a name built at
  run time (`["gi", "t"].join("")`), or a name read from a function call or an
  import.

### Subprocesses: `src/run.ts`

Start subprocesses only through `run`, `start`, or `startDetached` in
`src/run.ts`. Their options require `timeoutMs`. `lint/subprocess.grit` fails
on `Bun.spawn`, `Bun.spawnSync`, `Bun.$`, and `node:child_process` in any
other file. The OpenCode adapter (`opencode/llmos.ts`) is outside `cli/src`:
it spawns the committed hook bundles itself, and no lint covers it.

A hook arms one deadline for all its subprocesses (`src/hook-limits.ts`,
armed in `runHook` in `src/hooks/runtime.ts`), and `run` cuts each call to the
time left. `test/hooks/manifest.test.ts` fails when a hook's deadline plus its
reserve reaches its `hooks.json` timeout. Keep each hook call's limit at or
above the one it had before: the deadline is the bound.

### Locks: `src/lock.ts`

Take every lock through `src/lock.ts`: an exclusive SQLite transaction that
the kernel drops when its holder exits or crashes. It refuses a lock path that
is a symbolic link. A `HeldLock` frees its lock when it is garbage collected,
so keep the reference until `release()`. Keep lock files out of the vault work
tree, and never write a lock file that code must judge stale or remove.

A note write that reads, changes, and replaces a note runs in `withNoteLock`
(`src/write.ts`).

### Vault reads: `src/vault-file.ts`

`resolveInVault(root, relative)` is the only constructor of the branded
`VaultFile` type: the real path of a regular file inside the real vault root,
with no dot folder (`.trash/`, `.obsidian/`) in its path. It refuses `..`, an
absolute path, a link that leaves the vault, a link to a missing file, and a
folder. `readText` takes only a `VaultFile`, and the note writes of `write.ts`
take one from `resolveInVault`.

Two checks in `../biome.json` guard this door in `vault.ts`, `write.ts`,
`memory.ts`, `schema.ts`, `digest.ts`, `daily.ts`, `authoring.ts`, `health.ts`,
`mcp.ts`, `commands.ts`, and `src/hooks/context.ts`:

- `noRestrictedImports` bans `readFileSync`, `readFile`, `promises`, a default
  or namespace import of `node:fs` and `fs`, and all of `node:fs/promises` and
  `fs/promises`.
- `lint/vault-reads.grit` bans `Bun.file`, `require("fs")` and
  `require("node:fs")` (with or without `/promises`), and the cast
  `as VaultFile`.

Not caught:

- Every module outside that list. They read files that are not vault notes
  (config, state, install, the other hooks) or take outside paths on purpose.
  `sources.ts` is one: its capture of a URL note goes through `resolveInVault`,
  but the module also reads outside files, so nothing stops a new raw read
  there.
- Other ways to read or to forge a `VaultFile`: named `openSync`, `readSync`,
  and `createReadStream` imports from `node:fs`; `Bun.mmap`; an alias such as
  `const B = Bun; B.file(p)`; the angle-bracket cast `<VaultFile>p`; and a
  value of type `any` passed as a `VaultFile`.
- `readSkillFile` in `src/docs.ts`: an exported raw read of any path, kept for
  the `docs` command.
- `readWalkedNote(root, relative)`: it refuses `..` and an absolute path, but
  it follows a symbolic link out of the vault, as Obsidian does (the `read`
  command contract). It is for paths that `walkVault` listed.
- The PostToolUse hook (`src/hooks/stamp.ts`), which checks the files a tool
  just wrote wherever they are.

The Hermes provider (`hermes/`, Python) keeps its own containment code.

### Hook output: `emit()` in `src/hooks/runtime.ts`

A hook writes its output only through `emit()`, which gives each event the
envelope its harness reads. Hook, MCP, and memory code never writes to a
console or to stdout, and never reads the process folder to find its scope.

`lint/hook-channels.grit` applies to `src/hooks/`, `src/mcp.ts`, and
`src/memory.ts`, except the hook entry points (`main.ts`, `pre-tool-use.ts`)
and `runtime.ts`. It fails on `process.stdout`, `Bun.stdout`, `process.cwd`
(called or not), any use of the names `console` and `globalThis`,
destructuring `stdout` or `cwd` from `process`, `Bun`, or a `require` of
`process` or `bun`, and named imports of `stdout` or `cwd` from `process`,
`node:process`, or `bun`.

Not caught: a computed key such as `process["stdout"]`, an alias such as
`const p = process`, a default or namespace import of `process`, a `require()`
call that is not destructured, or an indirect read such as `process.env.PWD`,
`path.resolve(".")`, or `fs.writeSync(1, ...)`.

### MCP server: `src/mcp.ts`

The MCP server (`llmos mcp`) takes its arguments from a model. Check every
tool's arguments in its handler, keep every path inside the real vault root
through `src/vault-file.ts` (`resolveInVault`) or `src/write.ts`, and add no
shell or arbitrary-file tool. Claude Code reads `../.mcp.json`, Codex
`../.codex-mcp.json`, and Antigravity (`agy`) `../mcp_config.json`. Keep the
Bun flags `--no-install --no-env-file --config=/dev/null` in all three, so a
session's project cannot load code or config into the server.

## Bundles and Bun

The hooks that run on every tool call (`pre-tool-use`, `guard-bash`) have
their own entry point and bundle (`src/hooks/pre-tool-use.ts`). Keep YAML,
memory, and vault-model code out of its imports, because Bun loads the whole
bundle on every tool call.

`.tool-versions` pins the Bun version for local builds and CI
(`bun-version-file`). `just hooks` refuses another `bun`, because a bundle
built by another version differs from CI's. To move Bun, change that file and
the `@types/bun` version in `package.json` together.

A change to `../hooks/hooks.json` means that every host must approve the Codex
hooks again.

## Releases

The owner picks each release's version level. Ask the user whether the
release is major, minor, or patch, then run `just release <level>`. That
recipe is the only writer of the `version` in `.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`, `.antigravity-plugin/plugin.json`, and
`cli/package.json`, and it dates the CHANGELOG `## Unreleased` notes under the
new version.

`just release-check` (in `just check` and in CI) fails when the four fields
differ, when the version differs from `main` and the CHANGELOG has no heading
for it, and, in CI, when the version changes in a pull request not titled
`chore(release): ...`. It warns when shipped files changed since the last
release and the version stayed the same: hosts cache the plugin by version, so
a change reaches them only after a release.

The marketplace catalogs (`../.claude-plugin/marketplace.json`,
`../.agents/plugins/marketplace.json`) are generated from the plugin manifest
by `scripts/gen-marketplaces.ts` (`just gen`). The drift check in `just check`
fails when they differ.
