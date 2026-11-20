# The service

`llmos service serve` runs the llmOS service: one process per host that keeps the qmd models loaded for every session. `llmos mcp` starts it on first use. The protocol and rules are in `docs/service.md`.

## Sub-features

- `status` says whether a service runs.
- `start-on-first-use`: the first MCP `search` starts the service and answers itself.
- `socket-modes`: the state folder is mode 0700, the socket 0600.
- `shared`: the next MCP search and the CLI `search` use the service (its request count grows).
- `one-service`: a second `service serve` exits 0 and the first keeps running.
- `memory-save`: a save with the service up is found by keyword search at once.
- `fallback`: after the service stops, `llmos mcp` still searches.

## How to get to it (user POV)

- `llmos service status` and `llmos service serve`. `LLMOS_SERVICE=off` turns the service off.

## Driving it with scripts/verify.ts

Preconditions: launch and doctor passed. `drive read-search` ran first, so the qmd index exists, and `drive memory` ran first, so `projects/verify/` exists for the memory step. The drive uses a short state folder in the scratch folder (`XDG_STATE_HOME`) and `LLMOS_SERVICE=on`.

- **Status.** `service status`. `running` is false.
- **First search.** MCP `search {"query":"gardening"}` names `notes/beta.md`; then `service status` shows a running service.
- **Modes.** The folder is 0700, `service.sock` is 0600.
- **Shared.** A second MCP search and `llmos search gardening` raise `requests` in `service status`.
- **One service.** `service serve` prints `already listens`, exits 0, and the pid in `service status` is the same.
- **Memory.** `memory save` then `memory search --keyword` finds the note; `memory forget` removes it.
- **Fallback.** SIGTERM to the pid from `service status`; the socket file goes. MCP `search` still works.
- Run: `bun scripts/verify.ts drive service`. Evidence goes to `service/`.

## Gotchas

- Never in this drive: the warm models, semantic search, and the background embed. They need model files. Probe them in scratch with a model cache linked into an isolated `XDG_CACHE_HOME`.
- The drive stops only the service it started, by the pid from `service status`. The search with the service down starts a new service a moment later, so the drive waits for it and stops it too: no service outlives the scratch folder.
