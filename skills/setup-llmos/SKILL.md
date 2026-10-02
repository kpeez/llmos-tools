---
name: setup-llmos
description: Set up and verify llmOS access, agent-plugin activation, and hook coverage on a Mac or Linux host. Use when installing the llmOS integration for Codex or Claude, repairing missing vault guidance through project symlinks, or checking the vault root, Obsidian CLI, and qmd retrieval.
---

# Setup llmOS

Use this workflow on macOS or Linux, the supported llmOS desktop environments.
The doctor detects the OS and prints platform-specific repairs.

The reusable maintenance commands are installed with the `llmos-vault` uv tool.
The plugin root still owns this skill's `write_config.py` helper and the
lifecycle hooks.
When invoking that helper, `<llmos-plugin-root>` means the directory two levels
above this `SKILL.md`.

Run the bundled doctor before changing the machine:

```sh
llmos-doctor
```

If `llmos-doctor` is unavailable, install the tool from the llmos plugin
package before continuing:

```sh
uv tool install --editable "<llmos-plugin-root>"
```

The doctor is read-only. It reports `PASS` or `FAIL` for each available
prerequisite, prints an exact `REPAIR` command after every failure, and exits
nonzero when setup is incomplete. It checks vault, Obsidian, and qmd access;
it does not establish that either agent has loaded the plugin or trusted its
hooks. Verify those separately below.

## Workflow

1. **Run the doctor.** Treat the result as healthy only when the command
   exits `0`; binary presence alone is insufficient.
2. **If `vault-root` fails**, the machine has no `$LLMOS_ROOT` and no
   `~/.config/llmos/config.json`. Ask the user for the absolute path to their
   llmOS vault checkout, then write the config:

   ```sh
   python3 "<llmos-plugin-root>/skills/setup-llmos/scripts/write_config.py" "<path the user gave>"
   ```

   The script validates the path before writing anything — it must exist and
   contain both `.obsidian/` and `AGENTS.md`. It never writes a config
   pointing at a non-vault; on a rejected path it exits nonzero with the
   reason and writes nothing, so re-ask the user and retry rather than
   guessing or falling back to a nearby directory.
3. **Rerun the doctor** to confirm `vault-root` now passes.
4. **Review every remaining failure's `REPAIR` command** with the user.
   Obtain authorization before running commands that install software, open
   applications, or change qmd collections.
5. **Apply only authorized repairs**, then rerun the doctor until every check
   passes.

## Platform notes

The `obsidian-vault` check needs Obsidian already running with the `llmOS`
vault open and its command line interface enabled (Settings → General →
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
`config.toml` records it — so every new machine needs it again.

Do not "fix" this with `bypass_hook_trust = true` (or
`--dangerously-bypass-hook-trust`). Those are global: they disable trust review
for every hook from every installed marketplace, including remote ones, to solve
one local hook. Codex's own text calls the flag DANGEROUS and scopes it to
automation that already vets its hook sources.

Verify by what a session receives, never by what the config says:

```sh
codex exec --sandbox read-only "Do not use any tools. Did you receive a startup message mentioning 'llmOS root'? yes/no." </dev/null
```

`no` means the hook did not fire, whatever `plugin list` claims.

## Activate and verify each agent and host

The Python tool and the agent plugin are separate installations. Repeat this
checklist on each requested host; a successful Mac check says nothing about
Linux, and Claude activation says nothing about Codex.

- Inspect the agent's plugin list and configured marketplace source. Preserve
  existing sources and unrelated settings. Use the provider's supported
  marketplace/install/update commands from `--help`; never modify an active
  plugin cache in place or delete an old version to force reloading.
- For a local source checkout, both providers accept a local marketplace:
  `codex plugin marketplace add <checkout>` followed by
  `codex plugin add llmos@llmos-vault`, or
  `claude plugin marketplace add <checkout>` followed by
  `claude plugin install llmos@llmos-vault`. Inspect existing registrations
  before replacing them. Changes to an existing installation may require the
  provider's update command and a fresh session.
- Verify that `maintain-llmos`, `vault-cli`, and `setup-llmos` are available in
  the fresh agent session. Resolve the configured root, then verify that its
  `agents/references/authoring.md` exists. Do not create a rival copy inside
  the code repository or installed plugin cache.
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
