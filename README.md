# llmos-vault

The standalone plugin and maintenance tool for the shared **llmOS Obsidian
vault**. It bundles three skills, lifecycle hooks that keep vault writes
well-formed and indexed, and `llmos_vault`, a Python library with deterministic
CLI verbs for vault operations.

## Install the maintenance tool

Install the reusable vault maintenance commands with uv:

```sh
# From a checkout
uv tool install --editable /path/to/llmos-vault

# Directly from GitHub
uv tool install git+https://github.com/kpeez/llmos-vault
```

This installs `llmos-vault`, `llmos-audit`, `llmos-daily-activity`, and
`llmos-doctor` from the same repository that provides the plugin assets.

## Install the agent plugin

Claude Code:

```text
/plugin marketplace add kpeez/llmos-vault
/plugin install llmos@llmos-vault
```

Codex CLI:

```text
codex plugin marketplace add kpeez/llmos-vault
codex plugin add llmos@llmos-vault
```

## Contents

```text
llmos-vault/
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

## Hooks

`hooks/hooks.json` wires four lifecycle events. One script per concern, and
the same scripts serve both Claude and Codex — each `hooks.json` entry names
its event on the command line, and the JSON payload arrives on stdin the same
way on both harnesses.

| Event                  | Script                | Purpose                                                                                                     |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| SessionStart           | `llmos_hook.py`       | Injects vault context at session start (startup, resume, clear, compact)                                    |
| PreToolUse (Write/Edit)| `llmos_hook.py`       | Gates direct writes into the vault so they follow its conventions                                           |
| PreToolUse (Bash)      | `guard_bash.py`       | Guards `obsidian-cli` targeting and vault-unsafe `mv`/`rm`; a cheap pre-filter keeps the fast path silent   |
| PostToolUse (Write/Edit)| `llmos_stamp_hook.py`| Normalizes frontmatter, stamps `updated`, appends the writing provider to `authors`, flags the index dirty  |
| Stop                   | `llmos_qmd_hook.py`   | Reindexes the `qmd` llmos collection **iff** this turn dirtied the vault; a vault-untouched turn spawns nothing |

The stamp and reindex hooks share a session-scoped dirty flag
(`llmos_dirty_flag.py`), so concurrent sessions never collide or leak a stale
flag into each other.

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
- **`llmos-audit`** — audits frontmatter contracts across the vault; read-only
  unless `--fix` is passed.
- **`llmos-daily-activity`** — writes the machine-owned `## Projects` block of
  daily notes from GitHub activity. Deterministic: fetch → hash → one model
  call → verify → write.
- **`scripts/`** — compatibility entry points for source-checkout users and
  plugin helpers.

## Tests

`tests/` is a pytest suite run from the repository root (`uv run pytest`),
covering the hooks (gating, guards, stamp format, reindex), root resolution,
the CLI's backends, and vault health — against committed fixture vaults in
`tests/fixtures/`.
