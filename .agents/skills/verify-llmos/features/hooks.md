# Hooks

The hook bundle `dist/hooks.js` runs for Claude Code and Codex. Each event reads JSON on stdin and answers on its own output channel.

## Sub-features

- `session-start` prints vault context to stdout when the cwd is inside the vault.
- `pre-tool-use` returns `additionalContext` JSON for a tool call on a vault note.
- `guard-bash` exits 2 with the reason on stderr to deny a raw `mv` of a vault note or an untargeted `obsidian-cli` verb.
- `post-tool-use` stamps `updated` on a note a Write tool changed.
- `stop` runs a reindex after a turn that changed the vault. Not driven.

## How to get to it (user POV)

- The agent harness runs `bun --no-env-file --config=/dev/null dist/hooks.js <event>` from `tools/hooks/hooks.json`. A user never calls it by hand.
- The harness sets `CLAUDE_PLUGIN_ROOT`. The skill does not need it.

## Driving it with scripts/verify.ts

Preconditions: launch and doctor passed. The harness sets `CLAUDECODE=1`, as Claude Code does, so the hook heartbeat names `claude`.

- **session-start.** `echo '{"cwd":"<vault>","session_id":"verify"}' | bun dist/hooks.js session-start`. Exit 0. Stdout starts with `llmOS root: <vault>`.
- **session-start outside.** The same with `cwd` outside the vault. Exit 0, no output.
- **pre-tool-use.** Payload `{"tool_name":"Read","cwd":"<vault>","session_id":"verify","tool_input":{"file_path":"<vault>/notes/alpha.md"}}`. Stdout is JSON with `hookSpecificOutput.additionalContext` that says "Obsidian vault note".
- **guard-bash raw mv.** Payload `{"tool_name":"Bash","cwd":"<vault>","tool_input":{"command":"mv <vault>/notes/alpha.md /tmp/x.md"}}` with event `guard-bash`. Exit 2. Stderr names `obsidian-cli move`.
- **guard-bash untargeted.** Command `obsidian-cli read`. Exit 2. Stderr names `file=`.
- **guard-bash allowed.** Command `ls`. Exit 0, no stderr.
- **post-tool-use.** Payload with `tool_name: "Write"` and the path of `notes/alpha.md`. Exit 0. The note now holds `updated: <today>`.
- Run: `bun scripts/verify.ts drive hooks`. Evidence goes to `hooks/`.

## Gotchas

- A hook failure never blocks a tool. An error exits 0 with no output. An empty stdout alone does not prove the hook worked. Check the file effect for `post-tool-use`.
- The hooks write a heartbeat and a dirty flag. The harness keeps them in the scratch `HOME` and `TMPDIR`.
- Changing `src/hooks/` needs `just hooks` to rebuild `dist/hooks.js`. The harness drives the bundle, so a stale bundle shows as a failed check. `just hooks` needs the Bun version in `cli/.tool-versions`.
- The cloud path (`CLAUDE_CODE_REMOTE=true`) pulls a git vault. It is not driven.
