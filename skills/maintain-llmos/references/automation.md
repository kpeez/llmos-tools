---
status: active
authors:
  - codex
  - claude
created: 2026-07-15
updated: 2026-09-22
---

# Scheduled jobs

One scheduled job maintains llmOS: the evening daily activity digest. It is a
script, not an agent — fetch, hash, one model call, verify, write — so it cannot
drift, half-finish, or decide to do something else. It processes both today and
yesterday on each run, because an evening pass cannot see work that lands after
it.

The digest monitors every project whose landing note has `status: active` and
whose folder name matches a repository in `kpeez` or `linux-host-ucdavis` (vault
ADR 0009). It writes only between the `llmos-activity` markers in
`reviews/daily/YYYY-MM-DD.md`, creates a note only on a day with activity, and
never touches `## Thoughts`.

There is no nightly closeout and no weekly synthesis (vault ADR 0010). Neither
ever ran on a schedule. After a vault change, run `llmos-vault health` yourself.

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

Enable it with `systemctl --user enable --now llmos-daily-activity.timer`. Read
failures with `journalctl --user -u llmos-daily-activity`. The job needs `gh`
authenticated with read access to both orgs, `opencode` authenticated for the
pinned model, and the vault root in `~/.config/llmos/config.json` or
`$LLMOS_ROOT`. A failed run exits non-zero and writes nothing for the failed
day.
