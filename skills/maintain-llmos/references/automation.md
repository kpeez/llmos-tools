---
status: active
authors:
  - codex
  - claude
created: 2026-07-15
updated: 2026-10-08
---

# Scheduled and manual jobs

One scheduled job maintains llmOS: the evening daily activity digest. One
manual job, `discover`, leaves a record in the vault (see "Run records and manual jobs").
The digest is a script, not an agent — fetch, hash, one model call, verify, write — so it cannot
drift, half-finish, or decide to do something else. It processes both today and
yesterday on each run, because an evening pass cannot see work that lands after
it. The command is `tools/src/digest.ts`, run by Bun.

The digest monitors every project whose landing note has `status: active` and
whose folder name matches a repository in `kpeez` or `linux-host-ucdavis` (vault
ADR 0009). It writes only between the `llmos-activity` markers in
`reviews/daily/YYYY-MM-DD.md`, creates a note only on a day with activity, and
never touches `## Thoughts`. It refuses to write a note whose markers are not
exactly one start and one end.

PR and issue text is untrusted. The model runs as an opencode agent with every
permission denied, so it has no shell, file, or network tools and can only
return text. The digest accepts only a single text answer that links every PR
and issue by its GitHub URL (repository and number, so one `#N` cannot stand
for two repositories), and it writes `<!--` from that answer as `&lt;!--`, so no marker
can appear inside the block.

There is no nightly closeout and no weekly synthesis (vault ADR 0010). Neither
ever ran on a schedule. After a vault change, run `llmos-vault health` yourself. `health` can also report `discover` as overdue.

## Timer

A systemd user timer runs `llmos-daily-activity` at 22:30 local time.

`~/.config/systemd/user/llmos-daily-activity.service`:

```ini
[Unit]
Description=llmOS daily activity digest

[Service]
Type=oneshot
Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:/usr/bin:/bin
ExecStart=%h/.local/bin/llmos-daily-activity
```

`~/.config/systemd/user/llmos-daily-activity.timer`:

```ini
[Unit]
Description=Run the llmOS daily activity digest each evening

[Timer]
OnCalendar=*-*-* 22:30
Persistent=true

[Install]
WantedBy=timers.target
```

`%h/.local/bin/llmos-daily-activity` is the link that the CLI install creates
to `src/digest.ts` in the installed copy of `tools/`. The script starts with
`#!/usr/bin/env bun`, so the unit's `PATH` must find the mise-managed `bun`
through the mise shims. Do not put `~/.bun/bin` on it: on linux-host that folder
holds an older standalone Bun that would run first.

Enable it with `systemctl --user enable --now llmos-daily-activity.timer`. Read
failures with `journalctl --user -u llmos-daily-activity`. The job needs `gh`
authenticated with read access to both orgs, `opencode` authenticated for the
pinned model, and the vault root in `~/.config/llmos/config.json` or
`$LLMOS_ROOT`. A failed run exits non-zero and writes nothing for the failed
day.

## Run records and manual jobs

A manual job runs only when someone starts it, so a missed run makes no
noise. Each run of `discover` therefore leaves a record in the vault. It sets
the property `discovered: YYYY-MM-DD` (the local day of the run) on
`categories/Knowledge.md`. It also sets `updated` there. It adds the agent's
name to `authors` only when it detects an agent harness (Claude Code, Codex,
or Gemini); a run from a plain shell leaves `authors` as it is. The three
changes are one atomic write. Obsidian need not run. In the `llmos` vault, `set-property` and
`remove-property` refuse the `discovered` property of that note, also through
a link to it, and `create` refuses new content for it that sets the property.
Only `discover` sets it.

The record is a note edit, so it travels with the vault. The edit is committed
and pushed like any note edit. After the git sync, `llmos-vault health` on any
host reads it. A run on mac-host therefore counts on linux-host too.

`health` has an `overdue_jobs` section for the `llmos` vault. It lists
`discover` when any of these is true:

- `categories/Knowledge.md` or its `discovered` property is missing.
- The value is not a valid `YYYY-MM-DD` date.
- The date is more than 1 day after today. A later date fails closed. The 1
  day covers a time-zone difference between hosts.
- The date is more than 10 days before today. The weekly cadence allows 8
  days. The other 2 days cover the git sync between mac-host and linux-host.

Any entry makes `health` exit 1. A failed run sets nothing: the person who ran
it sees the error.

`discover` is a manual job. It is not on a timer. Run `llmos-vault discover`
when `health` reports it as overdue, and about once a week. It ranks clusters
of notes that restate the same works, as candidates for
`consolidate-knowledge`. It writes the JSON report to
`<vault root>/../artifacts/discover/YYYY-MM-DD.json` (the checkout's
`artifacts/` folder) and prints it. Use `--out DIR` for another folder. It
never writes inside the vault, except for the record above. It refuses to run
when `artifacts/` is missing and `--out` is not given. It also refuses
before any work when `categories/Knowledge.md` is missing, is a symbolic link,
or has frontmatter that the edit cannot rewrite (for example an anchored
`updated` or `authors`). The check runs the same edit without writing, so a
failed run never leaves a half record.

Use `--no-record` for a probe, such as a run on a copy of the vault: it then
leaves `categories/Knowledge.md` as it is and skips those checks.
`--vault second-vault` never writes the record.
