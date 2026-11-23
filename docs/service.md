# The llmOS service

This page is for people who use or change the llmOS service. It is one
long-lived process per host that keeps the qmd search models loaded. Every
agent session on the host shares that one warm model set. Without it, each
`llmos mcp` process loads its own models: about 1.5 s for the first semantic
search, and one model set of memory per process.

## Clients and fallback

- `llmos mcp` sends its `search` and `memory_search` calls to the service. When
  it finds no service, it starts one in the background. That call runs in the
  server's own qmd store.
- `llmos search` and `llmos memory search` use the service when it runs. They
  never start it.
- `llmos memory save` and `llmos memory forget` (and the matching MCP tools)
  update the keyword index of the `memory` collection, which needs no model.
  When a service runs, they also ask it to embed the memory collection in the
  background, under qmd's embed lock, so it never races `llmos reindex`. They
  never start the service or load a model.
- A client that cannot reach the service, or gets an error from it, runs the
  work itself. The one exception is a collection the index lacks: that answer
  is the final answer.

`llmos service status` says whether a service runs. `llmos doctor` reports the
same, with the socket path and which models are loaded.

## Lifecycle

- The service starts on first use. There is no launchd or systemd unit.
- It stops after 30 minutes without a request. `LLMOS_SERVICE_IDLE_MS` changes
  the limit. qmd's own 5-minute model unload is off in the service.
- Two starts at the same moment end as one service. A starter holds the start
  lock, checks whether a live service holds the socket, removes a socket file
  that no process listens on, and binds. The loser exits with code 0.
- The start lock is an exclusive SQLite transaction on `service.lock.db` in
  the state folder (`cli/src/lock.ts`, which the memory and sync locks use
  too). The kernel gives it to one process at a time and drops it when that
  process exits or crashes, so no process removes another's lock.
  A starter that waits more than 5 s for the lock exits with an error.
- A stopping service removes the socket path only through `server.close()`,
  which unlinks it before the listen ends. A new service binds only after the
  old one stops listening, so a stopping service never removes a newer
  service's socket.
- `just verify-llmos-service` model-checks these rules with TLA+ (the
  `verify-llmos-service` skill).
- `LLMOS_SERVICE=off` stops every client from using or starting the service.
- Stop a service with SIGTERM to the pid that `llmos service status` prints.

## Transport

A Unix socket, `service.sock`, in the llmOS state folder: `$XDG_STATE_HOME/llmos`,
else `~/.local/state/llmos`. The folder is mode 0700 and the socket mode 0600,
so only the user's own processes connect. The service has no port.

A Unix socket path has a length limit (104 bytes on macOS). When the path is
longer than 100 bytes, no service starts and clients run the work themselves.

## Protocol

One JSON object per line, in each direction. A client may send several
requests on one connection; the answers come back in order.

```text
request  {"id": 1, "method": "search", "params": {"query": "x", "collection": "memory", "limit": 5, "mode": "semantic"}}
success  {"id": 1, "ok": true, "result": [{"path": "...", "title": "...", "score": 0.7, "line": 3, "snippet": "..."}]}
failure  {"id": 1, "ok": false, "error": {"code": "collection_missing", "message": "..."}}
```

A standard-library Python client needs only `socket.AF_UNIX`, `sendall`, and a
read up to the newline.

| Method | Params | Result |
| --- | --- | --- |
| `status` | none | `pid`, `started_at`, `index`, `requests`, `idle_stop_ms`, `models` (`embed`, `rerank`, `generate`), `embedding` |
| `search` | `query` (1 to 1000 characters, no control characters), `collection` (`llmos` or `memory`), `limit` (1 to 200), `mode` (`keyword`, `semantic`, or `hybrid`) | the hits, as `llmos search` prints them |
| `embed` | `collection` (`llmos` or `memory`) | `{"accepted": true}`; the embed runs in the background |

Every method also takes an optional `index`, the qmd index path the caller
means. The service answers `index_mismatch` when it serves another index.

Error codes: `bad_request` (not JSON, an unknown or missing field, a value out of
range, or a line longer than 16 KiB), `unknown_method`, `index_mismatch`,
`no_index`, `collection_missing`, `internal`.

The service offers no shell, file, or arbitrary-path method. It serves the
`llmos` and `memory` collections only.

## The `memory` collection

Memory search and background embedding use a second qmd collection beside
`llmos` in the same index: the vault root with the pattern
`projects/*/memory/*.md`. The pattern takes the top-level notes of every memory
folder (the `MEMORY.md` index too) and no subfolder. qmd keeps one vector per
collection for a note in both collections, and one embed writes all of them,
so embedding `memory` also serves a semantic search on `llmos`. Add it once per host:

```bash
qmd collection add "<vault root>" --name memory --mask 'projects/*/memory/*.md'
```

`llmos doctor` fails until the collection exists and prints that command. While
it is missing, memory search falls back to the `llmos` collection.

Memory notes also change outside `llmos memory`: Claude Code writes its own,
the memory sync pulls them from other hosts, and people edit them by hand. So
`llmos reindex` of `llmos`, which the Stop hook runs with `--no-embed` after a
turn that changed the vault, also scans the `memory` collection when it exists.
Its fallback, `qmd update`, scans every collection.
