# Agent instructions

`tools/` is the `llmos` agent plugin. Its `cli/` folder is the llmOS CLI,
written in TypeScript and run by Bun
([ADR 0012](../llmOS/projects/llmos/adrs/0012-port-tools-to-typescript-on-bun.md)).
Run every command from `tools/cli/`; the paths below are relative to it. The
marketplace catalogs live at the repository root and point at `tools/`.

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

The `llmos-vault` CLI is a command registry (`src/commands.ts`, run by
`src/cli.ts`; entry points in `bin/`). Its contract is the command names,
flags, JSON output shapes, and exit codes (3: Obsidian not running), plus
the canonical frontmatter form on disk. Handlers return results and never
print or exit, so other front ends can call them. After changing a command's
help, run `bun bin/llmos-vault.ts docs`; a test fails while the vault-cli
reference is stale.

`Context.fetch` is the network seam of `source add`: tests pass a fetcher
that replays the recordings in `test/fixtures/web/` (or in-memory pages) and
never touch the network.

Never point a manual run or a test at the real qmd index
(`~/.cache/qmd`): set `INDEX_PATH`, `QMD_CONFIG_DIR`, and `XDG_CACHE_HOME`
to a temporary folder, as `test/helpers.ts` `isolatedEnv` does.

After a change to a command's behavior, the MCP server, or the hooks
(`src/`, `../dist/`, `../hooks/`), also run `just verify-llmos`. It drives the
real CLI, the MCP server, and the hook bundle on a scratch copy of a fixture
vault, and keeps the evidence in `../../artifacts/verify-llmos/<timestamp>/`.
The `verify-llmos` skill (`../../.agents/skills/verify-llmos/`) holds the
feature map and says which commands cannot run without Obsidian.
`scripts/bootstrap.sh` links `.agents/skills` into `.claude/skills` for Claude Code.

Preserve unrelated working-tree changes. Changes here go through a pull
request so CI runs. Tests use the fixture vaults in `test/fixtures/`, never
the real vault in `../../llmOS/`; point `LLMOS_ROOT` at a temporary vault for a
live probe.

Before declaring a change complete, run the relevant `just` recipes. The full
local gate is `just check` (after `bun install --frozen-lockfile`); it runs the
marketplace drift check, the type check, Biome, and `bun test` (with the
contract snapshot tests), and it fails when a committed bundle
(`../dist/hooks.js`, or the MCP launcher `../dist/mcp.js`) is stale. After changing
`src/hooks/`, `src/mcp-launcher.ts`, or core code they import, run `just
hooks` and commit the rebuilt bundles. `.tool-versions` pins the Bun version for
local builds and CI (`bun-version-file`); `just hooks` refuses another `bun`,
because a bundle built by another version differs from CI's. To move Bun,
change that file and the `@types/bun` version in `package.json` together. Changing `../hooks/hooks.json` means
every host must approve the Codex hooks again.

The MCP server (`src/mcp.ts`, `llmos-vault mcp`) takes its arguments from a
model: keep every tool's arguments checked in its handler, every path inside
the real vault root through `write.ts`, and add no shell or arbitrary-file
tool. Claude Code reads `../.mcp.json` and Codex `../.codex-mcp.json`; keep the
Bun flags `--no-install --no-env-file --config=/dev/null` in both, so a
session's project cannot load code or config into the server.

To check the frontmatter invariants on the real vault (every note reads,
`normalize` refuses no valid YAML, keeps every value, and is idempotent),
copy `../../llmOS/` to a directory outside it and pass the copy: `just
invariants <copy>`. Write any report (`bun test/contract/invariants.ts
--report FILE <copy>`) to `../../artifacts/`. Never point it at the live vault.

Never choose a release's version level yourself. Before you change the
`version` in `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and
`cli/package.json`, ask the user whether the release is major, minor, or
patch.

Marketplace catalogs (`../../.claude-plugin/marketplace.json`,
`../../.agents/plugins/marketplace.json`) are generated by
`scripts/gen-marketplaces.ts` (`just gen`) and must stay in sync with the
plugin manifest.
