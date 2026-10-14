# Skills

This page lists the plugin skills and the authoring rules they deliver.

| Skill                   | What it does                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `consolidate-knowledge` | Consolidates a note cluster into a topic hub, paper notes, and dataset notes; ends in a draft PR                     |
| `ingest-source`         | Sorts inbox items into sources, knowledge notes, and project material, and captures sources into frozen folders      |
| `maintain-llmos`        | Maintains the vault through its conventions: filing durable knowledge, project docs, reviews, link/property repair   |
| `setup-llmos`           | Diagnoses whether a machine can use the vault (Obsidian CLI, `qmd`), and configures the vault root when missing      |
| `vault-cli`             | Routes deterministic vault operations — read, list, move, link, file, daily notes, health — to the `llmos-vault` CLI |

The authoring contract lives in the vault at
`agents/references/authoring.md`. It guides meaningful wikilinks, heading and
block references, aliases, embeds, Bases, callouts, and diagrams. The plugin
delivers that contract when a tool targets vault content, including through a
repository's `.agents/docs` or `.agent/docs` symlink. The generic Obsidian
skills provide syntax help when installed; they do not replace the vault's
own conventions.

After editing a note, run `llmos-vault check <vault-relative-note.md>`.
It reports body links separately from frontmatter links and flags explicit
references to existing notes that are not links. Findings need author review;
the command never rewrites content or invents relationships. A clean check is
not a guarantee of useful connections or correct Obsidian rendering.
