# Changelog — llmOS tools

Newest first. Versions are the `version` field shared by
`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`.

## Unreleased

- The schema audit rejects a `categories` value that is not the exact plain
  name of a hub in `categories/`, such as `[[Paper]]` or
  `[[categories/Papers|Papers]]` (kpeez/llmos#56).
- The schema audit rejects the retired `repositories` property.
- `file-inbox` no longer stamps `[[Archive]]` when filing into `archive/`;
  no such hub exists.

## 2.3.1 — 2026-10-08

- `llmos-vault source add <arxiv-id|url|inbox-note>` captures an arXiv
  paper (from `arxiv.org/html/<id>`, pinned to the version fetched) or a web
  page into `sources/<slug>/`: `raw.html`, the images of the captioned
  figures in `assets/`, and `source.md` with the defuddle text and a manifest
  in its frontmatter. A source that is already captured is not fetched
  again. A PDF, or an arXiv paper without HTML, exits 1 and stays in the
  inbox. Requests go only to public http and https hosts, with at most five
  redirects, each hop checked; no body over 50 MB; figure images must be `image/*`.
- New `ingest-source` skill, which sorts inbox items and runs `source add`.
- `.gitattributes` stores `llmOS/sources/**` raw pages, PDFs, and assets in
  Git LFS.
- New dependencies: `defuddle` 0.19.4 (text extraction), with `linkedom`
  0.18.13 as its DOM and `turndown` 7.2.0 for Markdown.
- `package.json` now carries the plugin version (it said 0.2.0).

## 2.3.0 — 2026-10-07

- Retire the Python implementation (ADR 0012, kpeez/llmos#36): delete the
  `llmos_vault` package, its pytest suite, the unwired Python hooks, the
  source-checkout shims (`scripts/audit_metadata.py`, `doctor.sh`,
  `vault_root.py`, `write_daily_activity.py`), `pyproject.toml`, and
  `uv.lock`. No installed command changes: every host already runs the Bun
  CLI and hooks.
- Committed contract snapshots in `test/contract/` replace the differential
  harness and the digest parity check. They pin the CLI's JSON output and
  exit codes (except `list`'s exit code), the canonical `normalize` output,
  and the schema audit on the fixture vaults (now in `test/fixtures/`) and
  the generated edge vault, and the digest's outcomes, block hashes,
  markers, and notes on the digest edge days. They were recorded while Python was still the reference and checked
  against it; where TypeScript intentionally differs, the snapshot holds the
  TypeScript output and names the allowlist entry it replaces. `just
  contract-record` records them again after an intended contract change.
- The real-vault differential run becomes a TypeScript-only invariant check
  (`just invariants <vault-copy>`): every note reads, `normalize` refuses no
  valid YAML, keeps every value, and is idempotent.
- `scripts/gen-marketplaces.py` is now `scripts/gen-marketplaces.ts`, with
  byte-identical catalogs. CI and `just check` run Bun only; the `ts-types`,
  `ts-lint`, and `ts-test` recipes are now `types`, `lint`, and `test`.
- `scripts/install.ts` no longer replaces links into the retired
  `llmos-vault` uv tool, and the `setup-llmos` skill no longer covers
  removing that tool.

## 2.2.0 — 2026-10-07

- The canonical note writer keeps Markdown hard line breaks: a body line
  with content that ends in two or more spaces keeps that run of spaces when
  a note is stamped or normalized. It still trims a single trailing space,
  trailing tabs, other trailing whitespace, and lines of only whitespace, and
  the frontmatter block's canonical form is unchanged. The Python writer
  (frozen) still trims them; the differential allowlist lists this as an
  intended difference (`body-hard-line-break`).
- The activity digest's completeness check requires each PR and issue to be
  linked with its repository and number (a `github.com/OWNER/REPO/pull/N` or
  `/issues/N` URL, as the prompt asks), not just `#N`. Before, one `#N`
  counted for every repository with that number that day, and `#4` counted
  as found inside `#45`. The prompt now lists each required link with its
  URL. The block hash and markers are unchanged; the digest parity check
  compares the required links, reduced to their numbers, with Python's `#N`
  list.

## 2.1.0 — 2026-10-07

Codex hooks must be approved again: `hooks/hooks.json` gains a PreToolUse
matcher.

- Fix the activity digest hiding a newly opened PR when a PR with the same
  number merged that day in another repository. A merged PR now hides only
  itself (same repository and number). On such a day the block and its hash
  differ from the Python digest's; the digest parity check expects exactly
  this difference.
- Remove `src/compat.ts`, the layer that copied Python string, path, and date
  behavior (ADR 0012 as amended). Internal code now uses native TypeScript
  and Bun behavior; the canonical frontmatter writer keeps Python's
  whitespace set, line breaks, and code-point key order, because the on-disk
  form is part of the contract. Visible effects: `check`, `health`, and
  `llmos-audit` messages quote values as JSON (`"x"`, was `'x'`); an inbox
  note whose `created` is not `YYYY-MM-DD` (such as `20261005` or
  `2026-W40-3`) now counts as stale; lists sort by UTF-16 code unit, which
  differs from code-point order only between astral characters and
  U+E000–U+FFFF; a caller-typed note path and a `file-inbox` destination are
  normalized, so `a/../b` means `b`. The differential allowlist lists the
  first two as intended differences.
- `file-inbox` refuses a destination outside the vault with the vault-escape
  error before it checks the filing area.
- The schema audit finds new (untracked) notes with non-ASCII names; git's
  path quoting hid them before. A link property value ending in a newline is
  no longer a wikilink, and `created` must use ASCII digits.
- Add the plugin-declared `llmos` MCP server (ADR 0012, MCP phase):
  `llmos-vault mcp` on stdio, built on the official TypeScript MCP SDK
  (`@modelcontextprotocol/server` 2.0.0, the version qmd already installs).
  Read tools `read`, `neighbors`, `subgraph`, `check`, `health`, `search`;
  write tools `daily_append_thought`, `file_inbox`, `set_property`, which
  stamp `updated` and `authors` on the notes they change. Each tool runs the
  matching command's handler and takes its help. One vault model stays
  loaded and is read again when a note file changes; the qmd search models
  stay loaded after the first semantic search. Only the llmOS vault is
  served, and every note must resolve inside the real vault root.
- Claude Code starts it from `.mcp.json` and Codex from `.codex-mcp.json`,
  through the bundled launcher `dist/mcp.js`, with Bun's project `.env`,
  `bunfig.toml`, and auto-install off. Without an installed CLI the launcher
  serves a single `setup` tool. Codex runs the read tools without a prompt
  and asks before each write tool.
- The PreToolUse hook gives the MCP write tools the note schema and the
  authoring contract, under Claude Code's and Codex's tool names; the
  SessionStart context names the MCP tools.
- `llmos-doctor` gains an `mcp-server` check that starts the server and
  lists its tools.
- Changed: `llmos-vault search --semantic` is now vector search with the
  embedding model (about 0.8 s on mac-host), not qmd's hybrid pipeline. The new
  `--hybrid` flag runs the full pipeline (query expansion, keyword and vector
  retrieval, reranking; 13 to 22 s per query with the models loaded). The
  MCP `search` tool takes `semantic` and `hybrid` the same way.

## 2.0.0 — 2026-10-07

Breaking: the plugin hooks, the `llmos-vault` CLI, and the activity digest now
run on Bun. Each host needs `bun` on the hook `PATH` and a CLI install through
`setup-llmos`; Codex hooks must be approved again.

- Port the `llmos-vault` CLI, `llmos-doctor`, and `llmos-audit` to TypeScript
  on Bun (ADR 0012, CLI phase). Command names, flags, JSON output shapes, and
  exit codes are kept. `set-property`, `remove-property`, `append`,
  `daily append-thought`, `create` without a template, and the stamping step
  of `file-inbox` are now atomic file writes that work with Obsidian closed;
  only `move` and `create --template` need the app (exit 3 without it). Writes
  never leave the vault, also not through symbolic links.
- New verbs: `search` (qmd keyword search, `--semantic` for hybrid search)
  and `reindex` (qmd update, embed, and cleanup), through the qmd SDK pinned
  at `@tobilu/qmd` 2.8.3. `health` reads its qmd index gaps the same way.
- `setup-llmos` installs the CLI with `scripts/install.ts` into
  `~/.local/share/llmos/<version>/` and links `llmos-vault`, `llmos-doctor`,
  `llmos-audit`, `llmos-daily-activity`, and the pinned `qmd` into
  `~/.local/bin/`.
  `llmos-vault config set-root` replaces `write_config.py`. `llmos-doctor`
  fails unless exactly one `qmd` is on `PATH` and it is this install's.

- Add the TypeScript core in `src/` (ADR 0012, first phase): frontmatter on
  the `yaml` Document API that keeps block scalars, comments, and nested maps;
  one vault model for reads and the link graph; root resolution with a typed
  error; and the llmOS-profile reads. A differential harness compares it with
  the Python CLI, and CI runs the Bun checks beside the Python ones. The
  installed commands are unchanged.
- Port the daily activity digest to `src/digest.ts` (ADR 0012). For the same
  `gh` output it writes the same block hash, markers, and note as the Python
  digest; `test/differential/digest.ts` checks this. Unlike the Python
  digest, it runs the model as an opencode agent with every tool denied, it
  writes `<!--` from the model or a project title as `&lt;!--` so no marker
  can appear inside the block, and it refuses a note whose markers are not
  one start and one end.
- Run the plugin hooks from one Bun bundle, `dist/hooks.js` (ADR 0012, hooks
  phase), instead of Python scripts. Hosts need `bun` on the hook `PATH`, and
  Codex needs the changed hooks approved again. The stamp hook now keeps block
  scalars, comments, and nested maps instead of skipping those notes. The
  stop hook updates only the keyword index (`llmos-vault reindex --no-embed`,
  else `qmd update -c llmos`) and never embeds; run `llmos-vault reindex` by
  hand to embed, and `llmos-vault health` reports `qmd_unembedded`.
- The session-start hook records a heartbeat per agent in
  `${XDG_STATE_HOME:-~/.local/state}/llmos/hooks.json`, and `llmos-doctor`
  fails for an agent whose installed hooks have not run (no `bun` on the hook
  `PATH`, or untrusted Codex hooks) and warns after 7 days.

## 1.2.0 — 2026-10-07

- Move into the `kpeez/llmos` repository as `tools/`, beside the vault in
  `llmOS/`; `kpeez/llmos-vault` is retired. Marketplace catalogs move to the
  repository root and point at `./tools`; the marketplace keeps the
  `llmos-vault` name, so the plugin ID stays `llmos@llmos-vault`.
- `llmos-doctor` targets Obsidian by the vault folder's name instead of a
  fixed `llmOS`.

## 1.1.0 — 2026-10-01

- Recognize linked project documentation at startup and inject retrieval or
  authoring guidance for supported reads and writes after resolving symlinks.
- Deliver the vault's canonical Obsidian authoring contract for Markdown,
  Bases, and Canvas work; keep knowledge and syntax guidance discoverable
  through the existing skills.
- Add `llmos-vault check` and post-write feedback for unlinked references to
  existing notes, with body links reported separately from frontmatter links.
- Document per-host Codex and Claude activation, current hook trust, fresh
  session verification, and the limits of tool-call coverage.

## 1.0.6 — 2026-09-25

- Retire spec handling now that the vault holds no specs: the audit skips the
  `archive/specs/` deletion queue, a `specs/` folder no longer earns its own
  rules, inbox filing no longer stamps `[[Specifications]]`, and
  `llmos-audit --fix`, which only stamped specs, is removed.
- The daily activity digest derives each active project's repository from its
  folder name across `kpeez` and `linux-host-ucdavis` instead of reading a
  `repositories:` allowlist; a name found in both orgs is a hard failure.
- Replace the nightly closeout and weekly synthesis docs, which never ran, with
  the digest's systemd user timer.

## 1.0.5 — 2026-08-30

- Move the plugin and `llmos-vault` uv tool into the standalone `llmos-vault`
  repository with independent marketplace catalogs, CI, and package checks.
- Package all four maintenance commands while retaining source-checkout
  compatibility shims.
- Align the setup doctor with the canonical `AGENTS.md` vault sentinel.
- Keep failed qmd reindexing retryable with a non-blocking diagnostic.

## 1.0.4 — 2026-08-01

- Make hook commands fish-safe: `${CLAUDE_PLUGIN_ROOT}` becomes
  `"$CLAUDE_PLUGIN_ROOT"`, matching the swe plugin's fix — Codex runs hooks
  through the login shell, where fish rejects `${VAR}` as a syntax error.
- Add the nightly daily-activity digest script: scans monitored projects,
  gates on a content hash, summarizes with one pinned non-interactive OpenCode
  Go call, and writes the digest atomically.
- Update setup tests for the renamed install script and generated
  marketplace catalogs.

## 1.0.3 — 2026-07-17

- Add the `llmos_vault` Python package and the llmos-vault CLI: headless
  read/list verbs, a wikilink graph (neighbors, subgraph), mutation verbs
  (create, move, append, set/remove property) through an obsidian-cli write
  backend, and a vault health report covering orphans, dead-ends, unresolved
  links, schema violations, stale inbox, and qmd gaps.
- Add the `/vault-cli` router skill and generate the command reference docs
  from the CLI tree.
- Register vault hooks: a PreToolUse Bash guard for obsidian-cli targeting
  and vault mv/rm/git-rm, a PostToolUse hook that normalizes frontmatter and
  stamps authors/updated, and a Stop hook that reindexes qmd when dirty.
- Consolidate on one canonical frontmatter serializer; fix list-property
  corruption, mv/rm guard false positives, and bare-basename resolution.
- Add llmOS-profile daily-note helpers and file-inbox filing verbs.
- Skill-quality pass across `/maintain-llmos` and `/setup-llmos`.

## 1.0.2 — 2026-07-17

- Retire the daily-branch model from the plugin.
- Give the Codex hook-trust gate an owner in `/setup-llmos`; stop the
  SessionStart injection asserting a digest that is never built.

## 1.0.1 — 2026-07-16

- Deliver the note contract through the SessionStart injection — the only
  channel a model actually reads — naming the daily note by absolute path.
- Retire the receipt channel and both dead hook symlinks in setup;
  point `/maintain-llmos` at the daily note instead of receipts.
- Cover the metadata-audit seam moved by ADR-0007; drop stale Project Logs
  validation.

## 1.0.0 — 2026-07-16

- Initial release: scaffold the llmOS plugin and migrate core components —
  the `/maintain-llmos` and `/setup-llmos` skills, session hooks
  (`llmos_hook.py`), scripts for metadata audit, daily branches, vault-root
  resolution, daily receipts, and a doctor check, plus their test suite.
