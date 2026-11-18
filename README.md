# llmOS tools

The `llmos` agent plugin and the `llmos-vault` CLI for an llmOS vault, an
Obsidian vault at any path. Agents use them to read, write, search, and check
notes. The code is TypeScript, run by Bun.

## Install

On a new host, run `cli/scripts/bootstrap.sh <vault root>` from a checkout.
It installs the CLI and the plugin, points the CLI at the vault, and runs
`llmos-doctor`. The vault can be at any path.

To install the plugin by hand, in Claude Code:

```text
/plugin marketplace add kpeez/llmos
/plugin install llmos@llmos-vault
```

In Codex:

```text
codex plugin marketplace add kpeez/llmos
codex plugin add llmos@llmos-vault
```

In Antigravity (`agy`):

```sh
agy plugin install https://github.com/kpeez/llmos/tree/main/tools
```

In Hermes Agent, link `hermes/` into each profile's `plugins/` folder and
enable it; the `setup-llmos` skill lists every step (MCP server, skills,
`SOUL.md`).

To install the CLI by hand, see [CLI and scripts](docs/cli.md#install).

## Quick start

```sh
llmos-vault --help
llmos-vault health --vault llmos
```

Every command takes `--help`.

## What is included

| Part | What it does | Docs |
| --- | --- | --- |
| Skills | Five skills to file, ingest, consolidate, and repair notes, and to route CLI calls | [skills](docs/skills.md) |
| Hooks | Give agents vault context, guard shell moves, stamp frontmatter, and keep the index current | [hooks](docs/hooks.md) |
| MCP server | Typed read and write tools for the vault | [MCP server](docs/mcp.md) |
| CLI and scripts | `llmos-vault`, `llmos-doctor`, `llmos-audit`, `llmos-daily-activity` | [CLI and scripts](docs/cli.md) |

## Docs

- [Skills](docs/skills.md)
- [Hooks](docs/hooks.md)
- [MCP server](docs/mcp.md)
- [CLI and scripts](docs/cli.md)
- [Development](docs/development.md): layout, the TypeScript core, and tests.
