# CLI and scripts

This page is for people who run the llmOS CLI or its scripts.

## Install

On a new host, `cli/scripts/bootstrap.sh <vault root>` from a checkout installs
the CLI, sets the vault root (any path, such as the root of the vault's own Git
repository), installs the plugin for each agent on `PATH`, and runs
`llmos doctor`. The `setup-llmos` skill also
installs the CLI. By hand, from a checkout or the plugin root, with `bun` on
`PATH`:

```sh
bun <checkout>/cli/scripts/install.ts
```

This copies the plugin root to `~/.local/share/llmos/<version>/`, installs the
dependencies of its `cli/` folder there, links `llmos` and `qmd` into
`~/.local/bin/`, and, as its last step, points `~/.local/share/llmos/current`
at the new version. Hermes Agent runs its plugin through `current`. The `qmd`
is the version the CLI imports (`@tobilu/qmd`, pinned in `cli/package.json`);
keep it the only `qmd` on `PATH`.

## `llmos`

Every `llmos` command resolves the vault root, runs a handler that
returns a result, and prints JSON, so agents get predictable, parseable
output for reads, listings, moves, links, daily notes, inbox filing, graph
neighbors, search, and vault health checks. The command registry
(`cli/src/commands.ts`) is the one source of each command's help and of
`skills/vault-cli/references/commands.md`, the routing table skills use to
pick the right verb (`bun bin/llmos.ts docs`, run from `cli/`, renders it).

Vault-root resolution lives in `cli/src/root.ts`, which the CLI, the digest, the
hooks, and the MCP server share, so they agree on where the vault is.

## Subcommands and scripts

- **`llmos doctor`** — end-to-end health check: is the vault root valid, are
  the CLI and `qmd` reachable, is the collection indexed, does the MCP server
  start and list its tools, and have the installed plugin hooks run for each
  agent (Claude Code, Codex, Antigravity, Hermes Agent). It also reports the
  `memory` collection (`qmd-memory-collection`) and how many memory notes lack
  an embedding (`memory-embeddings`), the llmOS service (`service`: off,
  not running, or running with its loaded models), and each Hermes profile
  (`hermes-profile-<name>`: wired to llmOS or not).
- **`llmos audit`** — audits frontmatter contracts across the vault; read-only.
- **`llmos fmt [paths...] [--check]`** — formats notes with the rules of the
  [Obsidian Linter](https://github.com/platers/obsidian-linter) plugin and the
  vault's own Linter settings (`.obsidian/plugins/obsidian-linter/data.json`),
  so the result matches Obsidian's lint-on-save. It skips `raw/`, dot folders,
  and the Linter's ignored folders and files, and it fails when the vault has
  no Linter settings. `--check` writes nothing and exits 1 when a note would
  change. The plugin is the `obsidian-linter` GitHub dependency, pinned to one
  commit in `cli/package.json`. `cli/src/fmt.ts` loads its rules at run time
  behind a stub of the `obsidian` module, so no committed bundle holds it.
  Bump the pin with `bun add github:platers/obsidian-linter#<commit>`, then
  run `bun test test/fmt.test.ts`.
- **`llmos daily activity`** — writes the machine-owned `## Projects` block of
  daily notes from GitHub activity. Deterministic: fetch → hash → one model
  call → verify → write. It runs the model as an opencode agent with every
  tool denied.
- **`cli/scripts/`** — `install.ts`, the CLI install, `bootstrap.sh`, and `gen-marketplaces.ts`,
  which writes the marketplace catalogs at the repository root (`just gen`;
  `just check` and CI fail when a catalog is stale).
