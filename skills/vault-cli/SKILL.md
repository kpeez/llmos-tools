---
name: vault-cli
description: Route vault operations to the llmos MCP tools when the server is connected, else the llmos-vault CLI. Use when reading, listing, moving, linking, or filing notes, working with daily notes, checking vault health, or otherwise needing a deterministic headless verb against the llmOS vault or another Obsidian vault instead of hand-typed obsidian-cli calls.
---

# Vault CLI

## Prefer the MCP tools when they are connected

The plugin's `llmos` MCP server offers the common verbs as typed tools for
the llmOS vault: `read`, `list`, `neighbors`, `subgraph`, `check`, `health`,
and `search` to look notes up; `daily_append_thought`, `file_inbox`, and
`set_property` to write. Claude Code lists them as
`mcp__plugin_llmos_llmos__<tool>`, Codex as `mcp__llmos__<tool>`; their
schemas load on demand. When they are present, use them instead of the
matching verb: arguments need no shell quoting, the vault model and the
search models stay loaded, and the write tools stamp `updated`
themselves. Each tool's help is the help of the verb below.

Use them before `Grep` and `Read` too, because they return less text:
`search` finds notes about a topic; `read` with `section` returns one
heading's text and with `properties_only` only the frontmatter; `list` with
a `folder` returns the properties of every note there in one call.

Use the CLI for everything else: another vault (`--vault NAME`), `list` of the whole vault, `move`, `create`,
`append`, `remove-property`, `daily get-or-create`, `daily recent`,
`reindex`, and any session where the server is not connected. A `setup` tool
in its place means the CLI is not installed; run `setup-llmos`.

## The CLI

`llmos-vault` is a TypeScript CLI run by Bun. Its command registry
(`cli/src/commands.ts`) is the single source of truth for every verb's
parameters, behavior, and output shape. Discovery is two hops: this table
tells you which verb to run, `llmos-vault <cmd> --help` tells you everything
else.

Reads and content or property writes work with Obsidian closed: writes are
atomic file writes in the canonical frontmatter form. Only `move` and
`create --template` need the running app; they exit 3 when it is not
running. `search` and `reindex` use qmd's index through its SDK.

Keyword search stays current on its own: after each turn that changed the
vault, the plugin's Stop hook runs `llmos-vault reindex --no-embed`. Vectors
for `search --semantic` and `--hybrid` do not: embedding loads a model and takes seconds,
so no hook runs it. Run `llmos-vault reindex` by hand to embed. `llmos-vault
health` reports the count of documents that still need embedding as
`qmd_unembedded`.

## Verbs

<!-- BEGIN GENERATED VERB TABLE -->
| verb | summary |
| --- | --- |
| `append` | Append content to the end of an existing note. |
| `check` | Review one note for unlinked references and Markdown that renders wrongly. |
| `claims lint` | Check the fact and conflict callouts of notes: each quote occurs in its source section, and each number of a fact occurs in its quote. |
| `config set-root` | Validate a vault root and write it to the llmOS config file. |
| `create` | Create a new note; with --template, Obsidian creates it from a vault template. |
| `daily append-thought` | Append `text` under today's daily note's `## Thoughts` heading. |
| `daily get-or-create` | Print today's daily note as JSON, creating it from the daily template if it is missing. |
| `daily recent` | Print the last `n` daily notes' frontmatter and body as JSON, most recent first. |
| `discover` | Rank clusters of notes that restate the same works, as candidates to consolidate. |
| `docs` | Regenerate the vault-cli skill's command reference and verb table from this CLI. |
| `file-inbox` | File an inbox note: move it via obsidian-cli, stamp its destination properties, and record it in today's daily note. |
| `health` | Report vault hygiene: orphans, dead-ends, unresolved wikilinks, schema violations, stale inbox items, overdue jobs, and qmd index gaps. |
| `list` | Print every note in the vault with its frontmatter and body as JSON. |
| `mcp` | Serve the llmOS vault tools to an agent over MCP on stdin and stdout. |
| `move` | Move or rename a note via obsidian-cli, rewriting every backlink. |
| `neighbors` | Print one note's outgoing links, backlinks, and shared-topic siblings. |
| `read` | Print one note's frontmatter and body as JSON. |
| `reindex` | Update, embed, and clean up the qmd index for a collection. |
| `remove-property` | Remove a property from a note. |
| `search` | Search a qmd collection for notes: keyword by default, --semantic for vector search, --hybrid for qmd's full pipeline. |
| `set-property` | Set a property on a note. |
| `source add` | Capture an arXiv paper, web page, or PDF into a frozen source folder: raw bytes, figures, converted text, and a manifest. |
| `subgraph` | Print the transitive neighborhood of a note out to `depth` hops as JSON. |
<!-- END GENERATED VERB TABLE -->

Run `llmos-vault <cmd> --help` for a verb's full parameters, output shape,
and example invocations. The complete per-command docs (the same text
`--help` renders) are also collected in `references/commands.md`.

## Cold-agent walkthrough

Task: "what links to note X". Two hops:

1. Scan the table above for a verb about links -- `neighbors` reads
   "outgoing links, backlinks, and shared-topic siblings".
2. Run it: `llmos-vault neighbors X --vault llmos`.

No prior knowledge of the vault, the library, or Obsidian is required.

## Regenerating this file

This table and `references/commands.md` are generated from the command
registry -- never hand-edit either. After changing a command's help text or
adding a command, run from `cli/`:

```sh
bun bin/llmos-vault.ts docs
```

`bun test` fails while either file is stale.
