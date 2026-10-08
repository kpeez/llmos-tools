# llmOS tools

The plugin and maintenance tool for the shared **llmOS Obsidian vault**, which
lives beside this folder in `../llmOS/`. It bundles three skills, lifecycle hooks that keep vault writes
well-formed and indexed, and the llmOS CLI: deterministic verbs for vault
operations, written in TypeScript and run by Bun (`src/`, `bin/`). The Python
library `llmos_vault` is frozen and is being retired in phases
([ADR 0012](../llmOS/projects/llmos/adrs/0012-port-tools-to-typescript-on-bun.md));
the hooks still run from it.

## Install the maintenance tools

The `setup-llmos` skill installs the CLI. By hand, from a checkout or the
plugin root, with `bun` on `PATH`:

```sh
bun <checkout>/tools/scripts/install.ts
```

This copies `tools/` to `~/.local/share/llmos/<version>/`, installs its
dependencies there, and links `llmos-vault`, `llmos-doctor`, `llmos-audit`,
`llmos-daily-activity` (`src/digest.ts`), and `qmd` into `~/.local/bin/`. The
`qmd` is the version the CLI imports (`@tobilu/qmd`, pinned in
`package.json`); keep it the only `qmd` on `PATH`. On a host that still has
the retired Python uv tool, run `uv tool uninstall llmos-vault` first: uv
removes the command paths it recorded, which would otherwise delete the new
links.

## Install the agent plugin

Claude Code:

```text
/plugin marketplace add kpeez/llmos
/plugin install llmos@llmos-vault
```

Codex CLI:

```text
codex plugin marketplace add kpeez/llmos
codex plugin add llmos@llmos-vault
```

## Contents

```text
tools/
├── skills/
│   ├── maintain-llmos/    # vault conventions and maintenance workflows
│   ├── setup-llmos/       # machine access diagnosis + vault-root config
│   └── vault-cli/         # routing table for the llmos-vault CLI
├── hooks/                 # session/tool lifecycle hooks (see below)
├── llmos_vault/           # Python library and CLI (frozen; differential-test oracle)
├── src/                   # TypeScript core and the CLI's command registry
├── bin/                   # entry points: llmos-vault, llmos-doctor, llmos-audit, qmd
├── test/                  # bun tests and the differential harness
├── scripts/               # install.ts (the CLI install) and source-checkout shims
└── tests/                 # pytest suite with fixture vaults
```

## Skills

| Skill            | What it does                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `maintain-llmos` | Maintains the vault through its conventions: filing durable knowledge, project docs, reviews, link/property repair |
| `setup-llmos`    | Diagnoses whether a machine can use the vault (Obsidian CLI, `qmd`), and configures the vault root when missing |
| `vault-cli`      | Routes deterministic vault operations — read, list, move, link, file, daily notes, health — to the `llmos-vault` CLI |

The authoring contract lives in the vault at
`agents/references/authoring.md`. It guides meaningful wikilinks, heading and
block references, aliases, embeds, Bases, callouts, and diagrams. The plugin
delivers that contract when a tool targets vault content, including through a
repository's `.agents/docs` or `.agent/docs` symlink. The generic Obsidian
skills provide syntax help when installed; they do not replace the vault's
own conventions.

After editing a note, run `llmos-vault check <vault-relative-note.md>`.
It reports body links separately from frontmatter links and flags explicit
references to existing notes that are not links. Findings need author review;
the command never rewrites content or invents relationships. A clean check is
not a guarantee of useful connections or correct Obsidian rendering.

## Hooks

`hooks/hooks.json` wires four lifecycle events. One script per concern, and
the same scripts serve both Claude and Codex — each `hooks.json` entry names
its event on the command line, and the JSON payload arrives on stdin the same
way on both harnesses.

| Event                  | Script                | Purpose                                                                                                     |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| SessionStart           | `llmos_hook.py`       | Supplies vault context inside the vault and repositories with linked vault docs                            |
| PreToolUse (reads/edits)| `llmos_hook.py`       | Resolves target paths, supplies retrieval context on reads and the authoring contract before writes          |
| PreToolUse (Bash)      | `guard_bash.py`       | Guards `obsidian-cli` targeting and vault-unsafe `mv`/`rm`; a cheap pre-filter keeps the fast path silent   |
| PostToolUse (Write/Edit)| `llmos_stamp_hook.py`| Normalizes and stamps frontmatter, reports authoring findings, and flags the index dirty                     |
| Stop                   | `llmos_qmd_hook.py`   | Reindexes the `qmd` llmos collection **iff** this turn dirtied the vault; a vault-untouched turn spawns nothing |

The stamp and reindex hooks share a session-scoped dirty flag
(`llmos_dirty_flag.py`), so concurrent sessions never collide or leak a stale
flag into each other.

Hooks observe supported tool calls, not all filesystem access. Direct file
tools and patch edits have explicit targets; simple shell reads can be
recognized, but arbitrary scripts, pipelines, and other tools may not expose
their targets. Run the authoring check on changed notes at completion even
when a hook produced no diagnostic. `.base` and `.canvas` writes receive
authoring guidance; their format and rendering require their own checks.

Install the plugin separately from the Python tool, on each host and for each
agent. Codex requires review and trust of the current hook definitions; an
installed CLI or an old trust entry does not prove active hooks. See the
`setup-llmos` skill for activation and fresh-session verification. Existing
sessions may retain their previous plugin definitions.

## The `llmos_vault` library and CLI

`llmos_vault/` is a Python package (see `pyproject.toml`) exposing the
`llmos-vault` CLI. Every command is a thin wrapper: resolve `--vault` to a
root path, call a framework-free function, print JSON — so agents get
predictable, parseable output for reads, listings, moves, links, daily notes,
inbox filing, graph neighbors, and vault health checks. Command help renders
straight from docstrings; `skills/vault-cli/references/commands.md` is the
routing table skills use to pick the right verb.

Vault-root resolution lives in `llmos_vault/root.py` and is shared by the
hooks, the CLI, and the setup skill, so every entry point agrees on where the
vault is.

## The TypeScript core

`src/` is the TypeScript core: the vault model, the CLI, and the digest; the
hooks and the MCP server come in later phases.

- `frontmatter.ts` parses frontmatter with the `yaml` package's Document API
  and writes the canonical form: sorted keys, block-style lists, quoted
  wikilinks, one blank line after `---`, no trailing whitespace, one final
  newline. Block scalars, comments, and nested maps survive; a block with YAML
  errors is never rewritten; `created` is immutable and `authors` append-only.
  Every scalar reads as a string, as in the Python package.
- `vault.ts` loads every note once into one `VaultModel` with Obsidian's link
  resolution, and answers `read`, `list`, `neighbors`, `subgraph`, and the
  health link findings from it.
- `root.ts` resolves the vault root and Obsidian's vault registry, and throws
  `VaultRootError` instead of exiting.
- `schema.ts`, `authoring.ts`, `health.ts`, `daily.ts`, and `inbox.ts` port the
  llmOS-profile reads and computations.
- `cli.ts` and `commands.ts` are the `llmos-vault` command registry and entry
  point; `write.ts` does the headless writes, `obsidian.ts` the two
  obsidian-cli writes (`move`, `create --template`), `qmd.ts` search and
  reindex through the qmd SDK, and `doctor.ts` the `llmos-doctor` checks.
- `digest.ts` is the `llmos-daily-activity` command (run it with
  `bun src/digest.ts`). It replaces `llmos_vault/daily_activity.py` and
  writes the same block hash and markers for the same GitHub activity.

Set up with `bun install --frozen-lockfile`; check with `just ts-types`,
`just ts-lint`, and `just ts-test`.

## Scripts

- **`llmos-doctor`** — end-to-end health check: is the vault root valid, are
  the CLI and `qmd` reachable, and is the collection indexed.
- **`llmos-audit`** — audits frontmatter contracts across the vault; read-only.
- **`llmos-daily-activity`** — writes the machine-owned `## Projects` block of
  daily notes from GitHub activity. Deterministic: fetch → hash → one model
  call → verify → write. The TypeScript version (`src/digest.ts`) runs the
  model as an opencode agent with every tool denied.
- **`scripts/`** — compatibility entry points for source-checkout users and
  plugin helpers.

## Tests

`tests/` is a pytest suite run from `tools/` (`uv run pytest`),
covering the hooks (gating, guards, stamp format, reindex), root resolution,
the CLI's backends, and vault health — against committed fixture vaults in
`tests/fixtures/`.

`test/` holds the `bun test` unit tests for the TypeScript core and the
differential harness (`just differential`). The harness runs the Python CLI
and the TypeScript core on the fixture vaults and a generated edge-case vault
and fails on any difference not listed, with its reason, in
`test/differential/allowlist.ts`. `just differential-digest` runs both
activity digests on a generated vault with the same `gh` output and requires
the same block hash, markers, and note text.
