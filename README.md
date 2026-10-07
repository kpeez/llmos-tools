# llmOS tools

The plugin and maintenance tool for the shared **llmOS Obsidian vault**, which
lives beside this folder in `../llmOS/`. It bundles three skills, lifecycle hooks that keep vault writes
well-formed and indexed, and `llmos_vault`, a Python library with deterministic
CLI verbs for vault operations.

## Install the maintenance tool

Install the reusable vault maintenance commands with uv:

```sh
# From a checkout
uv tool install --editable <checkout>/tools

# Directly from GitHub (clones the whole repository, notes included)
uv tool install "git+https://github.com/kpeez/llmos#subdirectory=tools"
```

This installs `llmos-vault`, `llmos-audit`, `llmos-daily-activity`, and
`llmos-doctor` from the same repository that provides the plugin assets.

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
├── llmos_vault/           # Python library + `llmos-vault` cyclopts CLI
├── scripts/               # source-checkout compatibility shims
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

## Scripts

- **`llmos-doctor`** — end-to-end health check: is the vault root valid, are
  the CLI and `qmd` reachable, and is the collection indexed.
- **`llmos-audit`** — audits frontmatter contracts across the vault; read-only.
- **`llmos-daily-activity`** — writes the machine-owned `## Projects` block of
  daily notes from GitHub activity. Deterministic: fetch → hash → one model
  call → verify → write.
- **`scripts/`** — compatibility entry points for source-checkout users and
  plugin helpers.

## Tests

`tests/` is a pytest suite run from `tools/` (`uv run pytest`),
covering the hooks (gating, guards, stamp format, reindex), root resolution,
the CLI's backends, and vault health — against committed fixture vaults in
`tests/fixtures/`.
