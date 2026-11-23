# Development

This page is for people who change the code in this repository. Agent rules live in
[`AGENTS.md`](../AGENTS.md).

## Layout

```text
llmos-tools/
├── skills/
│   ├── consolidate-knowledge/ # consolidates a note cluster into a hub plus paper and dataset notes
│   ├── ingest-source/     # sorts inbox drops in raw/; captures sources with `source add`
│   ├── maintain-llmos/    # vault conventions and maintenance workflows
│   ├── setup-llmos/       # machine access diagnosis + vault-root config
│   └── vault-cli/         # routing table for the llmos CLI
├── hooks/                 # hooks.json: session/tool lifecycle hooks (see below)
├── dist/                  # committed bundles: hooks.js, pre-tool-use.js, and the MCP launcher mcp.js
├── .mcp.json              # the MCP server for Claude Code (.codex-mcp.json for Codex, mcp_config.json for agy)
└── cli/                   # the CLI's Bun project: package.json, bun.lock, justfile
    ├── src/               # TypeScript core and the CLI's command registry
    ├── bin/               # entry points: llmos, qmd
    ├── test/              # bun tests, contract snapshots, and fixture vaults
    └── scripts/           # install.ts (the CLI install), gen-marketplaces.ts, bootstrap.sh
```

The plugin root holds no `package.json`. Claude Code installs the dependencies
of a plugin whose root holds a `package.json` and a lockfile, and Claude
Desktop does not copy a plugin with the symbolic links of `node_modules/.bin/`
to an SSH host. So the Bun project lives in `cli/`, and every `bun` and `just`
command runs from there.

## TypeScript core

`cli/src/` is the TypeScript core: the vault model, the CLI, the digest, the
plugin hooks, and the MCP server.

- `frontmatter.ts` parses frontmatter with the `yaml` package's Document API
  and writes the canonical form: sorted keys, block-style lists, quoted
  wikilinks, one blank line after `---`, no trailing whitespace except a
  Markdown hard line break (two or more spaces) on a body line, one final
  newline. Block scalars, comments, and nested maps survive; a block with YAML
  errors is never rewritten; `created` is immutable.
  Every scalar reads as a string.
- `vault.ts` loads every note once into one `VaultModel` with Obsidian's link
  resolution, and answers `read`, `list`, `neighbors`, `subgraph`, and the
  health link findings from it.
- `root.ts` resolves the vault root and Obsidian's vault registry, and throws
  `VaultRootError` instead of exiting.
- `schema.ts`, `authoring.ts`, `health.ts`, `daily.ts`, and `inbox.ts` port the
  llmOS-profile reads and computations.
- `cli.ts` and `commands.ts` are the `llmos` command registry and entry
  point; `write.ts` does the headless writes, `obsidian.ts` the two
  obsidian-cli writes (`move`, `create --template`), `qmd.ts` search and
  reindex through the qmd SDK, and `doctor.ts` the `llmos doctor` checks.
- `digest.ts` is the `llmos daily activity` command. Its block hash and markers
  match the blocks already in daily notes. A PR merged in one repository does not hide a PR with the
  same number opened in another.
- `hooks/` holds the plugin hooks, bundled into `dist/hooks.js` and `dist/pre-tool-use.js` (see
  [hooks](hooks.md)).
- `mcp.ts` is the `llmos mcp` server, `mcp-launcher.ts` the launcher
  bundled into `dist/mcp.js`, `mcp-check.ts` the doctor's server check, and
  `mcp-names.ts` the tool names the hooks share (see [MCP server](mcp.md)).

From `cli/`, set up with `bun install --frozen-lockfile`; check with `just types`,
`just lint`, and `just test`, or all of them with `just check`. `just
verify-models` runs the TLA+ model checks (each `.agents/skills/verify-*`
skill with a `.tla` file). They need Java and TLC, so `just check` leaves them
out. CI runs both: the `check` job and the `models` job of
`.github/workflows/tools.yml`.

## Tests

`cli/test/` holds the `bun test` unit tests for the TypeScript core and the hook
tests in `test/hooks/` (gating, guards, stamp format, reindex; each runs the
hook as a `bun` process, as the harnesses do). `test/contract/` pins the
external contract with committed snapshots: the CLI's JSON output and exit
codes (except `list`'s exit code), the canonical `normalize` output, and the
schema audit on the fixture vaults in `test/fixtures/` and a generated
edge-case vault, and the activity
digest's outcomes, block hashes, markers, and notes on generated edge days
with a stand-in `gh` and model. A result that differs from the older Python
output on purpose names the reason. After an intended contract change,
`just contract-record` records them again for review.

The same tests check the frontmatter invariants on every note: reading never
fails with an untyped error, `normalize` refuses no valid YAML, keeps every
value, and is idempotent. `just invariants <vault-copy>` checks them on a
copy of the real vault.
