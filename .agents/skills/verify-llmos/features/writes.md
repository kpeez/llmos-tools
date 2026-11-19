# Write notes safely

A user or agent creates a note, appends text, and sets or removes a property. Every write stays inside the vault. Obsidian-only writes exit 3.

## Sub-features

- `create` writes a new note directly (no template).
- `append` adds text to the end of a note.
- `set-property` and `remove-property` edit one frontmatter key.
- `confinement` refuses a path outside the vault, a link out of the vault, and an immutable key.
- `obsidian-writes` are `move` and `create --template`. Both need Obsidian.

## How to get to it (user POV)

- CLI: `llmos create|append|set-property|remove-property|move`.
- MCP: `set_property`, `daily_append_thought`, `file_inbox`. See [mcp.md](./mcp.md).

## Driving it with scripts/verify.ts

Preconditions: launch and doctor passed. `notes/new.md` does not exist.

- **Create.** `llmos create notes/new --content hello`. Exit 0. `notes/new.md` holds `hello`.
- **Create twice.** Same command again. Exit is not 0. The note is not overwritten.
- **Create outside.** `llmos create ../../escape --content x`. Exit 1: "is not a path inside the vault". No file appears beside the scratch vault.
- **Set property.** `llmos set-property notes/new status active`. Exit 0. The file holds `status: active`.
- **Immutable key.** `llmos set-property notes/alpha created 2000-01-01`. Exit is not 0. `created` stays `2026-07-01`.
- **Append.** `llmos append notes/new "tail line"`. Exit 0. The file ends with `tail line`.
- **Remove property.** `llmos remove-property notes/new status`. Exit 0. The key is gone.
- **Link out of the vault.** The harness links `notes/link.md` to a file outside the vault. `set-property notes/link status pwned` exits not 0. The outside file is unchanged.
- **Obsidian verbs (verified-unreachable).** `llmos move alpha notes/z.md` and `llmos create notes/t --template project` exit 3: "obsidian-cli is not on PATH". Prerequisite: the Obsidian app running with its CLI on. A run on a host with Obsidian also checks that backlinks are rewritten.
- Run: `bun scripts/verify.ts drive writes`. Evidence goes to `writes/`.

## Gotchas

- The harness removes `obsidian-cli` from the child `PATH`. On a host with Obsidian the real app would act on its own registered vault, not the scratch copy. Never drive `move` there with the real `PATH`.
- `set-property` writes the value as a string.
- The link properties `categories`, `project`, and `topics` are append-only. Setting one adds a value.
- The `discovered` and `digested` keys are refused in the llmos vault. The fixture vault is not an llmOS-profile vault, so this is not driven.
