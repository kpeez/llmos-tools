# Changelog — llmOS tools

Newest first. Versions are the `version` field shared by
`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`.

## 2.6.1 — 2026-10-22

- The CLI's Bun project (`package.json`, `bun.lock`, `src/`, `bin/`,
  `test/`, `scripts/`, `justfile`) moved from the plugin root to `cli/`.
  Claude Code installs the dependencies of a plugin whose root holds a
  `package.json` and a lockfile, devDependencies included, and Claude Desktop
  does not copy a plugin with the symbolic links of `node_modules/.bin/` to an
  SSH host. So hosts reached over SSH from Claude Desktop had no `llmos`
  plugin. The plugin cache now gets no `node_modules`.
- Install the CLI with `bun <llmos-plugin-root>/cli/scripts/install.ts`. The
  install still copies the plugin root to `~/.local/share/llmos/<version>/`,
  and its `~/.local/bin` links now point into `cli/`. The MCP launcher
  accepts installs of both layouts.
- Run `bun` and `just` commands for the CLI from `tools/cli/`.
- A local-folder marketplace (`plugin marketplace add <checkout>`, as
  `bootstrap.sh` registers) still copies gitignored files into the plugin
  cache. Remove `tools/node_modules`, which the move leaves stale, and any
  `tools/cli/node_modules` from such a checkout before the plugin update, or
  use the GitHub source on hosts that Claude Desktop reaches over SSH.

## 2.6.0 — 2026-10-15

- `check` and the PostToolUse authoring check report a hard-wrapped
  paragraph or list item (`hard-wrapped-paragraph`). Obsidian shows every
  single newline as a line break, so agents that wrapped prose at 80 columns
  wrote notes that read as ragged broken lines. Block quotes, callouts,
  tables, code, hard line breaks, and the digest's `llmos-activity` block
  keep their lines.
- In a cloud session (`CLAUDE_CODE_REMOTE=true`), the vault is an attached
  repository: the cloud's GitHub proxy serves only attached repositories, so
  a vault cloned by a setup script cannot push. The session-start hook pulls
  `main` into the attached checkout, links `.agents/docs` in every repository beside it, and
  tells the agent to push vault notes to `main`, not the session branch. A
  session whose working folder holds several repositories also gets the
  vault context.
- New `scripts/bootstrap.sh` sets up a host from a checkout in one command.
  It installs the CLI, sets the vault root to `<checkout>/llmOS`, installs
  the `llmos` plugin for Claude Code and Codex when they are on `PATH`, runs
  `llmos-doctor`, and prints the steps that need a person. It keeps a root,
  marketplace, or plugin that is already configured.

## 2.5.1 — 2026-10-13

- The daily activity digest calls `github-copilot/claude-haiku-5.5`. The
  OpenCode Go subscription behind `opencode-go/deepseek-v4-flash` lapsed, and
  every nightly run from 2026-10-08 to 2026-10-12 failed with a 403.
- A failed `opencode run` now reports opencode's error event. opencode prints
  that error on stdout, so the journal used to show only
  `opencode run failed:` with no reason.
- The digest records each successful run without `--date` as `digested:
  YYYY-MM-DD` on `categories/Reviews.md`. `health` lists `daily-activity`
  under `overdue_jobs` when that date is missing, invalid, more than 1 day
  in the future, or more than 3 days old. `set-property`, `remove-property`, and `create` refuse that
  property, as they refuse `discovered`.
- `llmos-daily-activity --push` commits only the notes the run wrote and the
  run record, rebases on the upstream, and pushes. The linux-host timer passes
  it, so the digest reaches every host without a manual commit.
- `tools/.tool-versions` pins Bun 1.4.3 for local builds and CI. `just hooks`
  fails when `bun` is another version, because the committed bundles must
  match CI's build.

## 2.5.0 — 2026-10-10

- Narrow reads, so agents need not read whole notes to answer small questions.
  - `read --section HEADING` prints only the text under one heading, its
    subsections included. A heading that is missing or named twice is an
    error that lists the note's headings.
  - `read --properties-only` and `list --properties-only` leave out the body.
  - `list --folder PATH` keeps only the notes under one vault-relative folder.
  - The MCP `read` tool takes `section` and `properties_only`. A new MCP
    `list` tool returns the properties of every note under a required
    `folder`; it leaves out notes linked out of the vault.
- The session-start hook now routes agents to the MCP tools before `Grep` and
  `Read`, by task: `search` to find notes, narrow `read` and `list` for
  properties or one section, `neighbors` and `subgraph` for links. Before, it
  only preferred the tools over the CLI, and agents almost never called them.

## 2.4.3 — 2026-10-09

- `discover` no longer counts an embed of an existing file (`![[Reviews.base#Project]]`,
  an image) as a dangling link. Before, the project landing notes shared
  their Base embeds as dangling links and ranked first as one 16-note cluster
  that restated no work.

## 2.4.2 — 2026-10-08

- `source add` writes an image whose whole alt text is one bracketed phrase,
  as arXiv's `[Uncaptioned image]` is, as a plain Markdown image
  (`![Uncaptioned image](url)`), not as `![[Uncaptioned image]](url)`. Obsidian
  and `health` read the old form as an unresolved embed. Existing captures are
  frozen and keep the old form.

## 2.4.1 — 2026-10-08

- `health` reports fewer false positives, and the schema audit drops a dead rule.
  - A wikilink or embed that names an existing non-note file (`![[Topics.base#Topic members]]`,
    an image) resolves by its vault-relative path, then by its file name,
    ignoring a `#fragment`. The vault model now lists the non-note files for
    this. A file that does not exist stays unresolved.
  - A `[[...]]` inside a fenced code block (``` or ~~~, also unclosed) or an
    inline code span is no link, in `health`, `neighbors`, `check`, and every
    other command that reads links. Code spans follow CommonMark: a backslash
    escapes an opening backtick, a span closes only at a backtick run of the
    same length, and it never crosses a blank line or a heading.
  - Files in dot folders such as `.trash/` are not vault notes or link targets,
    as `.obsidian/` already was. A note inside `.trash/` no longer loads.
  - The MCP server's warm vault reloads when an image or other non-note file
    is added or removed, not only when a note changes.
  - In the llmos vault, `inbox/Inbox.md`, the inbox folder's hub note, is never
    a stale inbox item and never an orphan.
  - An orphan is a note that no other note links to and that has no valid
    category. A `categories` link that names a hub in `categories/` counts,
    because the hub's Base lists the note. So a daily note filed under
    `[[Reviews]]` is never an orphan, and an unfiled one is.
  - `health` (and the MCP `health` tool) now reports `orphans`, `dead_ends`,
    and the `referrer` of each unresolved link as vault-relative paths with
    `.md` (`projects/a/README.md`), not as file names. Many notes share a file
    name, so a name did not say which note it meant. This changes the JSON
    values and the text summary.
  - In the llmos vault, a note with a valid category and the inbox hub are not
    orphans. The second-vault vault (`--vault second-vault`) counts backlinks only.
  - In the llmos vault, a note in the root `templates/` folder is no orphan and
    no dead-end. An unresolved link from it is skipped only when its target is a
    placeholder, a target with `{{` and `}}` (such as `{{title}}.base` or
    `{{date:YYYY-MM-DD}}`). A template that links a real missing note still
    reports it. A link from a template resolves its target, but does not count
    as an inbound link, so a note that only a template links to stays an orphan.
    Folders named `templates` elsewhere are checked like any note. The second-vault
    vault reports templates as before.
  - The schema audit no longer skips `archive/specs/`, a folder the vault
    deleted. Notes under `archive/` are audited like any other note.

## 2.4.0 — 2026-10-08

- New `llmos-vault discover [--top N] [--out DIR] [--no-record]` ranks
  clusters of notes that restate the same works, as candidates for
  `consolidate-knowledge`. Signals: shared arXiv ids and DOIs, shared dangling
  links, shared `topics` without a topic note, and qmd similarity from the
  vectors already in the index (no model loads; without an index it skips the
  signal and says so). A cluster whose notes already link one `knowledge/`
  note reports `covered_by` and ranks after the uncovered ones. It writes the
  JSON report to `<vault root>/../artifacts/discover/YYYY-MM-DD.json` and never
  writes inside the vault (kpeez/llmos#55).
- `discover` is a manual job. Each run of the llmos vault sets
  `discovered: YYYY-MM-DD` on `categories/Knowledge.md` and sets `updated`
  there, in one atomic write. It adds the agent to `authors` only when it
  detects an agent harness. The record travels with the vault. `--no-record`
  skips it. Before any work, `discover` runs the same edit without writing and
  fails when that note is missing, is a symbolic link, or has frontmatter that
  the edit cannot rewrite. It writes nothing else in the vault.
  In the llmos vault, `set-property`, `remove-property`, and the MCP
  `set_property` refuse the `discovered` property of that note, also through
  a link to it; `create` refuses new content for it that sets the property.
- `health` has a new `overdue_jobs` section (llmos vault only, also in the MCP
  `health` tool). `discover` is overdue, and `health` exits 1, when the
  `discovered` date is missing, is not a valid `YYYY-MM-DD` date, lies more
  than 1 day in the future (time-zone skew), or is more than 10 days old.
- `discover` excludes `archive/` notes and reports dangling links and missing
  topics as counts. It ignores an edge of low weighted overlap
  (`MIN_OVERLAP`), so a note that cites many works no longer bridges
  unrelated clusters. A symbolic link planted at the report path no longer
  carries the write into the vault.
- `discover` reads identifiers more strictly. A DOI ends at the first
  character outside Crossref's suffix set and loses trailing punctuation and
  publisher page suffixes (`/full`, `/abstract`, `/pdf`, `/epdf`). The URL
  escapes of `/ ( ) : ; < >` are decoded. A DOI followed by `<` or `>` (SICI
  and AMS forms) is dropped; a `<https://doi.org/...>` autolink is kept. Text
  inside a wikilink never joins a DOI. A dated bioRxiv or medRxiv DOI keys on
  its date and number; another bioRxiv DOI loses its `.full`, `.abstract`,
  or `.supplementary-material` suffix and its version. An arXiv id must have the digit count and year range
  of its date.
- `llmos-doctor` warns about an unreadable heartbeat time instead of printing
  "NaN days ago".
- `llmos-vault check` also reports Markdown that makes Obsidian render a note
  wrongly: `table-column-count`, `empty-link`, `reversed-link` (markdownlint
  rules MD056, MD042, MD011), and `table-wikilink-pipe`, an unescaped alias
  pipe in a table wikilink that splits the cell (write `[[target\|label]]`).
  Notes under `sources/` and dot folders are skipped. The PostToolUse hook and
  the MCP `check` tool report them too. Adds the `markdownlint` dependency.

## 2.3.2 — 2026-10-08

- New `consolidate-knowledge` skill. It takes one cluster of related notes and
  writes the topic hub, plus paper and dataset notes whose facts quote
  captured sources, in a worktree on `claude/consolidate-<slug>`. It lints the
  facts, runs a second check in separate Claude subagents (a per-note fact
  prompt and a hub-prose prompt, in `references/`), checks privacy, and
  delivers the run as a draft pull request with fact counts by status and
  an estimated review time. A run over 30 minutes of review splits into
  smaller pull requests (kpeez/llmos#54).
- The schema audit rejects a `categories` value that is not the exact plain
  name of a hub in `categories/`, such as `[[Paper]]` or
  `[[categories/Papers|Papers]]` (kpeez/llmos#56).
- The schema audit rejects the retired `repositories` property.
- `file-inbox` no longer stamps `[[Archive]]` when filing into `archive/`;
  no such hub exists.
- `source add` points Markdown images at their downloaded copies with a
  single forward scan instead of a regular expression that took quadratic
  time on text such as `![a](` repeated (13.7 s for 200 KB; now about 15 ms).
  The result is the same, except that an image that starts inside another
  match's target is now also rewritten.
- New `llmos-vault claims lint <notes...> [--json]` checks the `[!fact]` and
  `[!conflict]` callouts of knowledge notes: each quote must occur in the
  linked heading's section of its captured source, and each number of a fact
  must occur in its quote (with `%`, `±`, signs, exponents, and attached identifiers). A quote needs
  at least 6 words, and the source's `sha256_text` is recomputed. Any finding
  exits 1; flagged
  facts are reported without failing, and superseded facts are skipped. The
  format is in `llmOS/agents/references/schema.md` and the conflict rule in
  `llmOS/agents/references/ingest-contract.md` (kpeez/llmos#53).
- A command's last argument can now take several values (`<paths...>`).

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
