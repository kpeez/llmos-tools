---
status: active
created: 2026-07-15
updated: 2026-11-18
---

# Scheduled and manual jobs

One scheduled job maintains llmOS: the evening daily activity digest. One
manual job is `discover`. Both leave a run record in the vault, and
`llmos health` reports a job whose record is too old (see "Run records
and manual jobs").
The digest is a script, not an agent — fetch, hash, one model call, verify, write — so it cannot
drift, half-finish, or decide to do something else. It processes both today and
yesterday on each run, because an evening pass cannot see work that lands after
it. The command is `llmos daily activity` (`cli/src/digest.ts`), run by Bun.

The digest monitors every project whose landing note has `status: active` and
whose folder name matches a repository of one of the GitHub owners in
`github_owners` of `~/.config/llmos/config.json`. The digest
fails when that list is missing or empty. It writes only between the `llmos-activity` markers in
`daily/YYYY-MM-DD.md`, creates a note only on a day with activity, and
never touches `## Thoughts`. It refuses to write a note whose markers are not
exactly one start and one end.

PR and issue text is untrusted. The model is `github-copilot/claude-haiku-5.5`
(`MODEL` in `digest.ts`). It runs as an opencode agent with every
permission denied, so it has no shell, file, or network tools and can only
return text. The digest accepts only a single text answer that links every PR
and issue by its GitHub URL (repository and number, so one `#N` cannot stand
for two repositories), and it writes `<!--` from that answer as `&lt;!--`, so no marker
can appear inside the block.

There is no nightly closeout and no weekly synthesis. Neither
ever ran on a schedule. After a vault change, run `llmos health` yourself. `health` also reports `discover` or `daily-activity` when its run record is too old.

## Timer

llmOS ships the digest command, not its schedule. The host that runs the digest
owns the schedule: run `llmos daily activity --push` once each evening with
the scheduler of that host. `health` reports a missed run whatever the
scheduler is (see "Run records and manual jobs").

The units below are an example for a Linux host: a systemd user timer that runs
the digest at 22:30 local time. On a Mac, a launchd agent with the same command
and a `StartCalendarInterval` of 22:30 does the same job.

`~/.config/systemd/user/llmos-daily-activity.service`:

```ini
[Unit]
Description=llmOS daily activity digest

[Service]
Type=oneshot
Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:/usr/bin:/bin
ExecStart=%h/.local/bin/llmos daily activity --push
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

`%h/.local/bin/llmos` is the link that the CLI install creates
to `cli/bin/llmos.ts` in the installed copy of the tools. The script starts with
`#!/usr/bin/env bun`, so the unit's `PATH` must find the mise-managed `bun`
through the mise shims. Do not put `~/.bun/bin` on it when that folder
holds an older standalone Bun: that Bun would run first.

Enable it with `systemctl --user enable --now llmos-daily-activity.timer`. Read
failures with `journalctl --user -u llmos-daily-activity`. The job needs `gh`
authenticated with read access to every configured owner, `opencode` authenticated with
GitHub Copilot (`opencode auth list`), and the vault root in
`~/.config/llmos/config.json` or `$LLMOS_ROOT`, and `github_owners` in that
config file, for example:

```json
{"vault_root": "/home/me/notes/vault", "github_owners": ["octocat", "octo-org"]}
```
 When the model's summary
omits the link to a PR or issue, the digest calls the model again, up to three
calls a day. A failed run exits non-zero, writes nothing for the failed
day, and leaves the run record as it was. The journal line gives opencode's
error message, for example a 403 from the model provider.

Do not move the digest to a free OpenCode Zen model. The free tier refuses a
request from an agent whose permissions are all denied, and the digest needs
that agent so that PR text cannot reach a tool. Several free models may also
keep prompts for training, and the prompts hold private-repository PR text.

The digest writes notes on the timer host only, and Obsidian Git commits nothing on
its own (every interval is 0). The timer therefore passes `--push`: after a
successful run, the digest commits only the notes it wrote and the run
record, with the message `daily activity: <dates>`. It then runs `git pull
--rebase --autostash` and `git push` in the timer host's checkout. Other edits in
that checkout stay uncommitted. A rebase conflict aborts the rebase and fails
the run, and a failed push fails it too. The next night's run pushes again.
The push uses the `gh` credential helper of the checkout's HTTPS remote, so
it needs no SSH agent.

## Run records and manual jobs

A missed run makes no noise: a manual job runs only when someone starts it,
and a failed timer run only writes to the journal of one host. Each job
therefore leaves a record in the vault.

Each successful digest run without `--date` sets `digested: YYYY-MM-DD` (the
Los Angeles day of the run) and `updated` on `categories/Reviews.md`. A
`--date` run, which re-processes one day, sets nothing.

Each run of `discover` sets
the property `discovered: YYYY-MM-DD` (the local day of the run) on
`categories/Knowledge.md`. It also sets `updated` there. The two
changes are one atomic write. Obsidian need not run. In the `llmos` vault, `set-property` and
`remove-property` refuse the `discovered` property of that note, also through
a link to it, and `create` refuses new content for it that sets the property.
Only `discover` sets it.

The record is a note edit, so it travels with the vault. The edit is committed
and pushed like any note edit. After the git sync, `llmos health` on any
host reads it. A run on one host therefore counts on every other host too.

`health` has an `overdue_jobs` section for the `llmos` vault. It lists
`daily-activity` when `digested` on `categories/Reviews.md` is missing, not
a valid date, more than 1 day after today, or more than 3 days before today
(the nightly cadence plus 2 days of slack). On another host an entry can also
mean that the nightly push from the timer host failed; run `health` on the
timer host to tell the two apart. It lists `discover` when any of these is true:

- `categories/Knowledge.md` or its `discovered` property is missing.
- The value is not a valid `YYYY-MM-DD` date.
- The date is more than 1 day after today. A later date fails closed. The 1
  day covers a time-zone difference between hosts.
- The date is more than 10 days before today. The weekly cadence allows 8
  days. The other 2 days cover the git sync between hosts.

Any entry makes `health` exit 1. A failed run sets nothing: the person who ran
it sees the error.

`discover` is a manual job. It is not on a timer. Run `llmos discover`
when `health` reports it as overdue, and about once a week. It ranks clusters
of notes that restate the same works, as candidates for
`consolidate-knowledge`. It writes the JSON report to
`<vault root>/../artifacts/discover/YYYY-MM-DD.json` (the checkout's
`artifacts/` folder) and prints it. Use `--out DIR` for another folder. It
never writes inside the vault, except for the record above. It refuses to run
when `artifacts/` is missing and `--out` is not given. It also refuses
before any work when `categories/Knowledge.md` is missing, is a symbolic link,
or has frontmatter that the edit cannot rewrite (for example an anchored
`updated`). The check runs the same edit without writing, so a
failed run never leaves a half record.

Use `--no-record` for a probe, such as a run on a copy of the vault: it then
leaves `categories/Knowledge.md` as it is and skips those checks.
A run on another vault (`--vault NAME`) never writes the record.
