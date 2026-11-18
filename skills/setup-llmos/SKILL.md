---
name: setup-llmos
description: Set up and verify llmOS access, agent-plugin activation, and hook coverage on a Mac or Linux host. Use when installing the llmOS integration for Codex, Claude, or Hermes Agent, repairing missing vault guidance through project symlinks, or checking the vault root, Obsidian CLI, and qmd retrieval.
---

# Setup llmOS

Use this workflow on macOS or Linux, the supported llmOS desktop environments.
The doctor detects the OS and prints platform-specific repairs.

The maintenance commands (`llmos-vault`, `llmos-doctor`, `llmos-audit`) and
`qmd` come from the llmOS CLI, a TypeScript program run by Bun. Below,
`<llmos-plugin-root>` means the directory two levels above this `SKILL.md`.
The host needs `bun` on `PATH`.

On a new host with a checkout of the repository,
`<checkout>/cli/scripts/bootstrap.sh <vault root>` does the install, the vault root, the
plugin install for each agent on `PATH`, and the first doctor run. Then
continue at the workflow below.

Install or update the CLI from the plugin root:

```sh
bun "<llmos-plugin-root>/cli/scripts/install.ts"
```

The script copies the plugin root to `~/.local/share/llmos/<version>/`, runs
`bun install --frozen-lockfile --production` there, and links `llmos-vault`,
`llmos-doctor`, `llmos-audit`, `llmos-daily-activity`, and `qmd` into
`~/.local/bin/`. It never changes the plugin folder or a plugin cache. It
replaces a `~/.local/bin` entry only when that entry links to an earlier
install; any other entry stops it before anything changes. `~/.local/bin`
must be on `PATH`.

The `qmd` it links is the qmd version the CLI imports. Keep it the only
`qmd` on `PATH`: two versions would write the same `~/.cache/qmd` index. If
the doctor finds another one (for example a global `mise` install of
`npm:@tobilu/qmd`), get the user's approval before removing it.

Run the doctor before changing anything else:

```sh
llmos-doctor
```

The doctor is read-only. It reports `PASS` or `FAIL` for each available
prerequisite, prints an exact `REPAIR` command after every failure, and exits
nonzero when setup is incomplete. It checks the vault root, Obsidian, that
exactly one `qmd` is on `PATH` and it is this install's, and that the qmd
index holds and returns the vault's `llmOS.md`. Its `mcp-server` check starts
the MCP server the plugin's launcher would start (the install that
`~/.local/bin/llmos-vault` links to) and passes only when it lists every
tool. For each agent with the plugin installed, it also checks that the
agent's hooks have run (see "Verify the hooks" below).

The plugin's Stop hook keeps qmd's keyword index current after each turn
that changed the vault (`llmos-vault reindex --no-embed`). It never embeds,
because loading the embedding model takes seconds. Embedding for
`search --semantic` and `--hybrid` is done by running `llmos-vault reindex` by hand;
`llmos-vault health` reports how many documents still need it
(`qmd_unembedded`).

## Workflow

1. **Run the doctor.** Treat the result as healthy only when the command
   exits `0`; binary presence alone is insufficient.
2. **If `vault-root` fails**, the machine has no `$LLMOS_ROOT` and no
   `vault_root` in `~/.config/llmos/config.json`. Ask the user for the
   absolute path to their llmOS vault folder. It can be at any path, such as
   the root of its own Git repository. Then write the config:

   ```sh
   llmos-vault config set-root "<path the user gave>"
   ```

   The command validates the path before writing anything — it must exist and
   contain both `.obsidian/` and `AGENTS.md`. It never writes a config
   pointing at a non-vault; on a rejected path it exits nonzero with the
   reason and writes nothing. It keeps the other keys of the config file.
   Re-ask the user and retry rather than
   guessing or falling back to a nearby directory.
3. **Rerun the doctor** to confirm `vault-root` now passes.
4. **Review every remaining failure's `REPAIR` command** with the user.
   Obtain authorization before running commands that install software, open
   applications, or change qmd collections.
5. **Apply only authorized repairs**, then rerun the doctor until every check
   passes.

## Platform notes

The `obsidian-vault` check needs Obsidian already running with the llmOS
vault open (Obsidian names a vault by its folder name) and its command line interface enabled (Settings → General →
Advanced → Command line interface).

- **macOS** ships the `obsidian-cli` binary inside the app bundle; the repair
  symlinks it onto `PATH`.
- **Linux** ships the `obsidian-cli` binary inside the snap
  (`/snap/obsidian/current/app/obsidian-cli`); the repair installs the snap and
  symlinks it into `~/.local/bin`. Do not wrap `obsidian` itself: with no
  running app it launches Obsidian instead of failing, and never returns. Run
  the doctor from within the desktop session so `DISPLAY`/`WAYLAND_DISPLAY`
  and the session D-Bus address are set; otherwise the CLI cannot reach the
  running app.

## Hooks need `bun` on the hook `PATH`

The plugin hooks run `bun "$CLAUDE_PLUGIN_ROOT"/dist/hooks.js <event>`. The
harness, not your interactive shell, must find `bun`: Claude Code runs hooks
with its own environment, and Codex runs them through the login shell. When
`bun` is missing, every hook fails without blocking anything, and the session
gets no vault context, stamps, or guards. A `bun` on your shell `PATH` does
not prove the hooks can see it; the heartbeat check below does.

## Verify the hooks: one fresh session per agent, then the doctor

Every time the session-start hook runs, it records a heartbeat in
`${XDG_STATE_HOME:-~/.local/state}/llmos/hooks.json`, keyed by agent
(`claude`, `codex`): the time, the Bun version, the SHA-256 of the hook
bundle that ran, and the plugin root. `llmos-doctor` finds the installed
plugin for each agent (Claude's `~/.claude/plugins/installed_plugins.json`,
Codex's `[plugins."llmos@llmos-vault"]` in `~/.codex/config.toml` and its
plugin cache) and checks the heartbeat against it:

- `PASS hooks-<agent>`: the installed hooks have run.
- `FAIL hooks-<agent>`: no heartbeat, or the last one ran another bundle than
  the installed one. Either no session started since the plugin was
  installed or updated, or the hooks cannot run: `bun` is not on the hook
  `PATH`, or (Codex) the hooks are not trusted. The `REPAIR` line names
  which.
- `WARN hooks-<agent>`: the heartbeat is more than 7 days old.
- `NOTE hooks-<agent>`: the plugin is not installed for that agent.

So the verification is: start one fresh session per agent (in any folder),
end it, then run `llmos-doctor`. It must pass for every agent with the plugin
installed. The probes in the next section are for troubleshooting a
failure.

## Codex needs the hook trusted once

On Codex, installing the plugin is not enough to make its hooks run. Codex
records each hook in `~/.codex/config.toml` under `[hooks.state]` with a
`trusted_hash` before it will execute it, and **an untrusted hook is skipped
silently** — no error, no warning. `codex plugin list` still reports
`llmos@llmos-vault  installed, enabled`, and the session receives nothing.

Inspect `codex plugin list --marketplace llmos-vault --json` and the llmOS
entries under `hooks.state` in the current Codex configuration. Parse JSON
and TOML with the host's structured-data tooling. A stale cache directory,
plugin list entry, or nonempty trust record alone is insufficient: trust is
for the current hook definition and can become stale after an update.

If it is not trusted, the repair is a human one: open Codex interactively and
approve the llmOS hook when prompted. It persists, and only that machine's
`config.toml` records it — so every new machine needs it again, and so does
every plugin update that changes `hooks/hooks.json`.

Do not "fix" this with `bypass_hook_trust = true` (or
`--dangerously-bypass-hook-trust`). Those are global: they disable trust review
for every hook from every installed marketplace, including remote ones, to solve
one local hook. Codex's own text calls the flag DANGEROUS and scopes it to
automation that already vets its hook sources.

Verify by what a session does, never by what the config says: the doctor's
`hooks-codex` check passes only after a Codex session ran the installed
hooks. To troubleshoot a failure, ask a fresh session from the vault root:

```sh
codex exec --sandbox read-only "Do not use any tools. Did you receive a startup message mentioning 'llmOS root'? yes/no." </dev/null
claude -p "Do not use any tools. Did you receive a startup message mentioning 'llmOS root'? Answer yes or no."
```

`no` means the hook did not fire, whatever `plugin list` claims.

## Verify the MCP server in a session

The plugin declares an MCP server named `llmos` (`.mcp.json` for Claude Code,
`.codex-mcp.json` for Codex). It needs `bun` on the `PATH` the agent gives
its MCP servers and the CLI install. Without the install it offers only a
`setup` tool, which means: run `cli/scripts/install.ts`, then start a new
session. In Claude Code, `/mcp` lists the server as `plugin:llmos:llmos`; in
Codex, `/mcp` lists `llmos`. Codex runs the read tools without a prompt and
asks before each write tool (`daily_append_thought`, `file_inbox`,
`set_property`); a user entry for that server in `config.toml` replaces those
settings.

## Hermes Agent

Hermes Agent has no plugin marketplace for llmOS. Wire it by hand, once in
the default profile (`~/.hermes`) and once in each profile under
`~/.hermes/profiles/`; each profile has its own `config.yaml`, `SOUL.md`, and
`plugins/` folder. Edit `config.yaml` as text and keep its comments.

- MCP: add `llmos` under `mcp_servers` with `command:
  ~/.local/bin/llmos-vault` (written out in full) and `args: [mcp]`. Hermes
  names the tools `mcp__llmos__<tool>`, as Codex does. Check with
  `hermes -p <profile> mcp list`.
- Skills: add `<checkout>/tools/skills` to `skills.external_dirs`, and add
  `obsidian` to `skills.disabled` (the bundled skill writes raw Markdown).
  `hermes config get skills.disabled` warns that the key is unknown; the
  skill loader reads it anyway. Check with `hermes -p <profile> skills list`.
- Commands: add `llmos-vault *` to `command_allowlist`.
- Hooks: link the adapter into the profile's `plugins/` folder and enable it:
  `ln -s <checkout>/tools/hermes <profile-home>/plugins/llmos`, then
  `hermes -p <profile> plugins enable llmos`. The gateway reloads plugins
  at once. `hermes plugins doctor llmos` validates the plugin.
- `SOUL.md`: say that the vault holds all project knowledge, and that
  Hermes memory (`MEMORY.md`, `USER.md`) holds only facts about Hermes
  itself. Copy the vault paragraphs of the default profile's `SOUL.md`.

The adapter (`hermes/__init__.py`) runs `dist/hooks.js` for each
Hermes hook; [hooks.md](../../docs/hooks.md) lists the mapping. The doctor
checks `hooks-hermes` when `~/.hermes/plugins/llmos` exists. Once any profile
links the plugin, it also checks each profile (`hermes-profile-<name>`) and names
the pieces a profile lacks, so a profile made later is not missed. Start one new
Hermes session (`hermes chat --oneshot -Q -q ok`) to record its heartbeat.

## Activate and verify each agent and host

The llmOS CLI and the agent plugin are separate installations. Repeat this
checklist on each requested host; a successful Mac check says nothing about
Linux, and Claude activation says nothing about Codex.

- Inspect the agent's plugin list and configured marketplace source. Preserve
  existing sources and unrelated settings. Use the provider's supported
  marketplace/install/update commands from `--help`; never modify an active
  plugin cache in place or delete an old version to force reloading.
- For a local source checkout, both providers accept a local marketplace at
  the repository root:
  `codex plugin marketplace add <checkout>` followed by
  `codex plugin add llmos@llmos-vault`, or
  `claude plugin marketplace add <checkout>` followed by
  `claude plugin install llmos@llmos-vault`. Inspect existing registrations
  before replacing them. Changes to an existing installation may require the
  provider's update command and a fresh session. Claude Code copies a local
  marketplace's plugin with its gitignored files, so a `cli/node_modules`
  or a pre-2.6.1 `node_modules` in the checkout puts symbolic links in
  the plugin cache, and Claude Desktop then does not copy the plugin to SSH
  hosts. On a host that Claude Desktop reaches over SSH, use the GitHub source
  (`kpeez/llmos-tools`), or remove those folders before the plugin update.
- Verify that `maintain-llmos`, `vault-cli`, and `setup-llmos` are available in
  the fresh agent session. Resolve the configured root, then verify that its
  `authoring.md` exists. Do not create a rival copy inside the code repository
  or installed plugin cache.
- From a repository with a real `.agents/docs` or `.agent/docs` symlink into
  the vault, verify startup guidance, a supported read, and a disposable edit
  through that symlink. Confirm the read receives retrieval guidance and the
  edit receives the authoring contract and post-write findings. Keep fixture
  output in the code repository's `artifacts/`, outside the real vault; use a
  temporary configured vault for the edit probe.
- Run `llmos-vault check` for a representative changed note. Validate Base
  queries and rendering through the explicitly targeted Obsidian CLI when
  available. Report headless checks separately when the desktop app is closed.

Hooks see tool calls, not arbitrary filesystem access. Document the tested
tools and the unobserved routes; absence of a hook diagnostic is not proof
that a shell script or external tool followed the authoring contract.
