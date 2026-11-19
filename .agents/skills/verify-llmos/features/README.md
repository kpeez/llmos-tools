# llmOS tools verification map

This folder is the source for verifying the user-facing behavior of the llmOS tools.
Read this index, then use the feature file as the recipe.

## Baseline preconditions

- Run `bun scripts/verify.ts launch` first. It makes a scratch copy of `cli/test/fixtures/vault`.
- The scratch vault holds the notes `alpha`, `beta`, `gamma`, `delta`, `epsilon`, `messy`, and `normalized` under `notes/`.
- `LLMOS_ROOT` is the scratch vault. qmd lives in the scratch `home/`.
- Run `bun scripts/verify.ts doctor` and require `DOCTOR OK`.
- Never drive the real vault in `llmOS/`.

## Driving conventions

- Run commands from `cli/` with `bun bin/llmos.ts <command>`. `scripts/verify.ts` does this for you.
- Treat each command, flag, and exit code as literal.
- Exit codes: 0 ok, 1 error or refusal, 2 usage, 3 Obsidian not running.
- Run features in the order of this index. `writes` adds `notes/new.md` and `notes/link.md`, so the `mcp` feature depends on that.

## Proof and skip reporting

- Keep the command, exit code, stdout, and stderr of every step.
- Show a second view of every write: read the file back from the scratch vault.
- Report an unreachable path with the command tried and the missing prerequisite.
- Do not report a skipped path as verified through another path.

## Features

- [Read and search notes](./read-search.md): `read`, `list`, `neighbors`, `health`, `reindex --no-embed`, keyword `search`.
- [Write notes safely](./writes.md): `create`, `append`, `set-property`, `remove-property`, vault confinement. `move` and `create --template` are verified-unreachable (Obsidian).
- [Lint claims](./claims-lint.md): `claims lint` on the fact and conflict callouts.
- [Capture a source](./source-capture.md): `source add` on recorded pages. Real network capture is not driven.
- [Hooks](./hooks.md): session-start context, pre-tool-use context, the Bash guard, the post-tool-use stamp.
- [MCP server](./mcp.md): the stdio tools, argument checks, and vault confinement.

## Not covered

- `daily get-or-create`, `daily append-thought`, `daily recent`, `file-inbox`, `discover`, `check`, `subgraph`, `config set-root`, `docs`.
  `file-inbox` and `daily get-or-create` need Obsidian (verified-unreachable). The rest are not in the seed map yet.
- The Stop hook and the cloud session-start path (`CLAUDE_CODE_REMOTE=true`).
- `llmos doctor`, `llmos audit`, and `llmos daily activity`.
