# Shared memory

`llmos memory` reads and writes shared project memory (ADR-0020): `projects/<project>/memory/` holds a `MEMORY.md` index of one-line links and one topic note per memory. Claude Code, the MCP memory tools, and the Hermes memory provider use the same store.

## Sub-features

- `scope` names the project, folder, and index of a session.
- `save` writes a topic note and its index line; a second save replaces the body and keeps one line.
- `search --keyword` returns only the topic notes in the scope's folder.
- `forget` deletes the note and its index line.
- `project-checks` refuse a project that is not a folder under `projects/`.

## How to get to it (user POV)

- `llmos memory scope|save|search|forget`, from any folder. `--project NAME` picks the project; without it, `--workspace PATH` (default: the current folder) does.

## Driving it with scripts/verify.ts

Preconditions: launch and doctor passed. `drive read-search` ran first, so the qmd index exists. The drive makes `projects/verify/` in the scratch vault.

- **Scope.** `memory scope --project verify`. Exit 0. `index` is `projects/verify/memory/MEMORY.md`.
- **Save.** `memory save garden-soil "Soil for the garden beds" "Use loam with compost." --project verify --type project`. Exit 0. `garden-soil.md` holds `node_type: memory`; `MEMORY.md` holds `- [Garden soil](garden-soil.md) — Soil for the garden beds`.
- **Save again.** The same name with the body `Use sandy loam.`. The note holds `sandy loam`; `MEMORY.md` names `garden-soil.md` once.
- **Search.** `reindex --no-embed`, then `memory search loam --keyword --project verify`. The paths are exactly `["projects/verify/memory/garden-soil.md"]`.
- **Project outside projects/.** `memory save x d b --project ..`. Exit 1.
- **Forget.** `memory forget garden-soil --project verify`. Exit 0. The note is gone and `MEMORY.md` no longer names it.
- Run: `bun scripts/verify.ts drive memory`. Evidence goes to `memory/`.

## Gotchas

- Semantic search (the default) needs the embedding model, which the scratch run does not download. The drive uses `--keyword`.
- A save updates the keyword index of the qmd collection at once, so `--keyword` finds it. Semantic search finds it after the service embeds it, or after `reindex`.
- The drive does not run the Hermes provider. `cli/test/hermes-memory.test.ts` drives it with a stub of Hermes, including recall, whose semantic half finds nothing there because the test index has no vectors. To see semantic recall, probe in scratch with real models, as `features/service.md` says.
