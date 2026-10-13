---
name: maintain-llmos
description: Maintain the shared llmOS Obsidian vault. Use when an agent files or retrieves durable knowledge, updates project docs, writes daily-note Thoughts, migrates documents into llmOS, repairs links or properties, or extracts a recurring workflow into a shared skill. Also use when editing llmOS notes through a repository's .agents/docs or .agent/docs symlink.
---

# Maintain llmOS

Treat llmOS as the canonical shared store; keep reusable knowledge shared. No provider writes memory into the vault (ADR-0003) — `agents/` holds only `references/`. Project ADRs live under `projects/<project>/adrs/`. The vault holds no specs.

## Workflow

1. Use the `llmos` MCP tools when the server is connected (`read`, `neighbors`, `search`, `daily_append_thought`, `set_property`, and the rest; see the `vault-cli` skill), and the installed `llmos-vault` and `llmos-audit` commands otherwise, for vault resolution and maintenance. Never derive the vault from the working directory or a file's location (ADR-0001).
2. Read `[[llmOS]]`, `AGENTS.md`, `agents/references/schema.md`, and
   `agents/references/authoring.md`, then the nearest area or canonical project
   note/landing page with `obsidian-cli vault="llmOS" read path="..."`.
3. Delegate broad vault exploration (multi-note reads, wide `qmd` sweeps) to a bounded subagent; keep synthesis and cross-cutting decisions with the primary agent.
4. Use the MCP `search` tool or `llmos-vault search "<terms>"` (or `qmd search -c llmos`) for exact retrieval, and `semantic: true` or `--semantic` (vector search, about 1 s; `qmd vsearch -c llmos`) for retrieval by meaning. Use `hybrid: true` or `--hybrid` (query expansion and reranking, 13 to 22 s per query; `qmd query -c llmos`) only when both miss. Read full hits with the MCP `read` tool, `llmos-vault read`, or `qmd get` before using them.
5. Classify linked `categories`, linked `topics`, and linked `project` (omitting
   empty properties), then file the result with the matching template using the
   schema and directory map at `$LLMOS_ROOT/agents/references/schema.md`; use
   `$LLMOS_ROOT/agents/references/authoring.md` for body links and Obsidian
   features. These vault files remain canonical through a repository's
   `.agents/docs` symlink.
6. In body prose, label internal links with a readable title, concept, or phrase
   that fits the sentence. Keep `.md` extensions and vault paths out of visible
   text unless the literal filename or path is itself the subject.
7. A configured and trusted PostToolUse hook stamps `authors` and `updated`
   after supported Write/Edit/apply_patch operations, and the MCP write tools
   stamp the notes they change themselves. Neither covers shell writes (the
   `llmos-vault` write verbs included) or an inactive hook; stamp those edits
   manually. `authors` means "touched the file," not meaningful contribution.
8. Record insight, not activity. GitHub already holds what happened, and the
   evening digest writes it into each daily note's `## Projects` block. When a
   day produces a lesson, an open question, or a decision with no ADR yet, write
   it under `## Thoughts` in `reviews/daily/YYYY-MM-DD.md` — prose, in your own
   words. Never restate commits, issues, or PRs there. The `## Projects` block is
   machine-owned — the digest regenerates it wholesale, so never hand-write the
   day's activity into it.
9. After each changed note, regardless of write tool, run
   `llmos-vault check <vault-relative-path> --vault llmos` to inspect body links,
   property links, unlinked note references, and Markdown that renders wrongly. Then verify the rendered note
   and any changed Base views in Obsidian, confirm project backlinks, run
   `llmos-audit`, check unresolved links, update qmd, and review Git status.

## Promote recurring patterns

When a workflow or hard-won lesson will recur across projects or providers, create or update a focused sibling skill in this plugin during the same task. Skills live in this repository, never in the vault — the vault holds notes. Use the skill creator, keep instructions concise, put deterministic behavior in scripts, and run `quick_validate.py`.

## Git

Commit routine work straight to `main`. Cut a branch only when a diff is worth reading before it lands — a multi-session migration, or a change worth a pull request — and name it `<agent>/<slug>`, with no date. There is no daily branch and no squash-merge closeout; see the vault's ADR 0008.

## Scripts

`llmos-audit` is read-only. It does not stamp `authors`/`updated` — the PostToolUse hook owns those.

The only scheduled job is the daily activity digest; `references/automation.md` specifies it and its timer. There is no nightly or weekly reviewer. `llmos-vault discover` is a manual job: run it when `health` lists it under `overdue_jobs`. When `health` lists `daily-activity`, the nightly digest has stopped: read its journal on linux-host before anything else (`references/automation.md`, "Run records and manual jobs").
