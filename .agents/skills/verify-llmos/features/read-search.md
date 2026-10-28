# Read and search notes

A user or agent reads one note, lists notes, follows links, checks vault health, and finds notes by keyword. All of it works with Obsidian closed.

## Sub-features

- `read` prints one note as JSON: `name`, `path`, `properties`, `body`.
- `list` prints every note with its frontmatter and body.
- `neighbors` prints outgoing links, backlinks, and shared-topic siblings.
- `health` reports vault hygiene.
- `reindex-scan` updates the qmd index without embedding.
- `search-keyword` finds notes by BM25 keyword.

## How to get to it (user POV)

- CLI: `llmos-vault read|list|neighbors|health|reindex|search`.
- MCP: the tools `read`, `list`, `neighbors`, `health`, `search`.
- Slash skill `llmos:vault-cli` routes to these verbs.

## Driving it with scripts/verify.ts

Preconditions: launch and doctor passed. The qmd collection `llmos` exists in the scratch home.

- **Read.** `llmos-vault read notes/alpha.md`. Exit 0. `properties.topics` is `["gardening"]`.
- **List.** `llmos-vault list`. Exit 0. The output names `beta`.
- **Neighbors.** `llmos-vault neighbors alpha`. Exit 0. The output names `beta`.
- **Health.** `llmos-vault health`. Exit 0 or 1. The report runs. The fixture has an unresolved link `[[ghost]]`.
- **Reindex.** `llmos-vault reindex --no-embed`. Exit 0. `update` counts the notes. `embed` and `cleanup` are `null`.
- **Search.** `llmos-vault search gardening`. Exit 0. The paths `notes/alpha.md`, `notes/beta.md`, and `notes/gamma.md` are in the JSON array.
- Run: `bun scripts/verify.ts drive read-search`. Evidence goes to `read-search/`.

## Gotchas

- Search fails with "no qmd index" until launch added the collection. Launch makes the `home/.cache/qmd` folder first. Without it SQLite cannot open the file.
- `--semantic` and `--hybrid` load models and may download them. The proof run does not drive them.
- A full `reindex` embeds and loads a model. Use `--no-embed`.
- `health` may exit 1 on the fixture. Judge the report, not the exit code.
