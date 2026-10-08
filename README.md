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

`hooks/hooks.json` wires four lifecycle events to one file,
`dist/hooks.js`, which `bun build` bundles from `src/hooks/`. It runs from
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
| SessionStart             | `session-start` | `context.ts`  | Supplies vault context inside the vault and repositories with linked vault docs                            |
| PreToolUse (reads/edits) | `pre-tool-use`  | `context.ts`  | Resolves target paths, supplies retrieval context on reads and the authoring contract before writes          |
| PreToolUse (Bash)        | `guard-bash`    | `guard.ts`    | Denies `obsidian-cli` note verbs without `file=`/`path=` and raw `mv`/`rm` of vault notes (exit 2, reason on stderr) |
| PostToolUse (Write/Edit) | `post-tool-use` | `stamp.ts`    | Normalizes and stamps frontmatter, reports authoring findings, and flags the index dirty                     |
| Stop                     | `stop`          | `stop.ts`     | Updates the keyword index **iff** this turn dirtied the vault: `llmos-vault reindex --no-embed`, else `qmd update -c llmos`; never embeds |

The stamp writes through the frontmatter serializer in `src/frontmatter.ts`,
so block scalars, comments, and nested maps keep their data. A note without a
frontmatter block, with a block the serializer refuses, or with invalid UTF-8
is left unchanged. The stamp and reindex hooks share a session-scoped dirty
flag, so concurrent sessions never collide or leak a stale flag into each
other. A hook failure never blocks the tool call, and the hooks never import
qmd (it would cost about 48 ms per call). Embedding is left to a hand-run
`llmos-vault reindex`; `llmos-vault health` counts the documents that still
need it.

Because a hook that cannot start fails silently, the session-start hook
records a heartbeat per agent in `${XDG_STATE_HOME:-~/.local/state}/llmos/hooks.json`
(time, Bun version, bundle SHA-256, plugin root), and `llmos-doctor` fails
for an agent whose installed hooks have not run. See the `setup-llmos`
skill.

After changing `src/hooks/`, rebuild the bundle with `just hooks` and commit
it; `just check` and CI fail when it is stale. `bun test/hooks/bench.ts
<vault-copy>` times every event. The Python scripts in `hooks/` are frozen
and no longer wired; they remain as the reference until the Python package is
retired.

Hooks observe supported tool calls, not all filesystem access. Direct file
tools and patch edits have explicit targets; simple shell reads can be
recognized, but arbitrary scripts, pipelines, and other tools may not expose
their targets. Run the authoring check on changed notes at completion even
when a hook produced no diagnostic. `.base` and `.canvas` writes receive
authoring guidance; their format and rendering require their own checks.

Install the plugin separately from the Python tool, on each host and for each
agent. Codex requires review and trust of the current hook definitions; an
installed CLI or an old trust entry does not prove active hooks, and any
change to `hooks.json` needs a new approval. See the
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
CLI and the setup skill; the hooks use its port in `src/root.ts`. Every entry
point agrees on where the vault is.

## The TypeScript core

`src/` is the TypeScript core: the vault model, the CLI, the digest, and the
plugin hooks; the MCP server comes in a later phase.

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
  writes the same block hash and markers for the same GitHub activity, with
  one fix: a PR merged in one repository no longer hides a PR with the same
  number opened in another.
- `hooks/` holds the plugin hooks, bundled into `dist/hooks.js` (see
  [Hooks](#hooks)).

Set up with `bun install --frozen-lockfile`; check with `just ts-types`,
`just ts-lint`, and `just ts-test`.

## Scripts

- **`llmos-doctor`** — end-to-end health check: is the vault root valid, are
  the CLI and `qmd` reachable, is the collection indexed, and have the
  installed plugin hooks run for each agent.
- **`llmos-audit`** — audits frontmatter contracts across the vault; read-only.
- **`llmos-daily-activity`** — writes the machine-owned `## Projects` block of
  daily notes from GitHub activity. Deterministic: fetch → hash → one model
  call → verify → write. The TypeScript version (`src/digest.ts`) runs the
  model as an opencode agent with every tool denied.
- **`scripts/`** — compatibility entry points for source-checkout users and
  plugin helpers.

## Tests

`tests/` is a pytest suite run from `tools/` (`uv run pytest`),
covering the frozen Python hooks, root resolution, the CLI's backends, and
vault health — against committed fixture vaults in `tests/fixtures/`.

`test/` holds the `bun test` unit tests for the TypeScript core, the hook
tests in `test/hooks/` (gating, guards, stamp format, reindex; each runs the
hook as a `bun` process, as the harnesses do), and the differential harness (`just differential`). The harness runs the Python CLI
and the TypeScript core on the fixture vaults and a generated edge-case vault
and fails on any difference not listed, with its reason, in
`test/differential/allowlist.ts`. `just differential-digest` runs both
activity digests on a generated vault with the same `gh` output and requires
the same block hash, markers, and note text, except on a day with that fix's
difference, where it checks that the difference is exactly that PR.
