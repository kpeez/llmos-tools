---
name: verify-daily-digest
description: Model-check with TLA+ that the daily digest never deletes a thought or a note that someone writes while the digest waits on the model. Use when a change touches processDay, atomicWrite, replaceBlock, or newNoteText in tools/cli/src/digest.ts, or how daily notes are written (tools/cli/src/daily.ts, tools/cli/src/write.ts), or when `just verify-daily-digest` fails.
---

# Verify the daily digest's note write

## The rule

`NoThoughtLost`: every thought that a writer saved is still in the daily note.

Harm when it breaks: the digest silently deletes a thought that Kyle or an
agent wrote to today's note, or replaces a note that someone created, while
the digest waited on the model.

## Run it

From `tools/cli/`:

```sh
just verify-daily-digest
```

The recipe runs `scripts/check.ts`. It exits 0 only when all three hold:

- `NoThoughtLost` holds on the model of the code (`Write = "fresh"`);
- `NoThoughtLost` breaks on the stale-write mutant (`Write = "stale"`), so
  the check can still fail;
- `tools/cli/src/digest.ts` still has each line in `GUARDS` in
  `scripts/check.ts`: the read before the model call, and the second read
  just before the write.

The first run installs Java and the pinned TLC jar with mise, and needs the
network. Set `TLA2TOOLS` and `JAVA` to use another TLC. A run takes a few
seconds.

## What the model covers

`DailyDigest.tla`, with `DailyDigest.cfg` (2 thoughts, 1 digest run):

| Model | Code |
| --- | --- |
| `DigestReadsNote` | `processDay`: `const text = existsSync(notePath) ? readText(notePath) : "";`, before `completeSummary` |
| `DigestWritesNote` | `processDay`: `atomicWrite(notePath, replaceBlock(readText(notePath), block))` when the note exists, else `atomicWrite(notePath, newNoteText(...))` |
| `WriterCreatesNote` | Kyle creates the note in Obsidian, or `daily append-thought` creates it (`ensureDaily` in `commands.ts`) |
| `WriterAddsThought` | Kyle in Obsidian, or `daily_append_thought` (`bodyWithThought` in `daily.ts`, written by `write.ts`) |

Assumptions, which the check does not cover:

- `DigestWritesNote` is one step. In the code, the second `readText` and the
  rename in `atomicWrite` are two calls with no lock. A save in that window,
  a few microseconds, is still lost. The model covers the model-call window,
  which is seconds to minutes. Only a lock that every writer takes closes the
  last window, and Obsidian takes no lock.
- One digest run at a time: the systemd timer starts one service.
- `--push` (`pushNotes`) and Git merges between hosts are not modeled.

Sync commit: `fa2f9fd` (fix(digest): keep text written to the note during
the model call). At that commit, the model describes the code.

## When a change touches the covered code

1. Run `just verify-daily-digest` before and after the change.
2. Read the code change against the table above. When a step changed shape,
   such as a new read, a write moved before the model call, or a new writer
   of daily notes, change `DailyDigest.tla` to describe the new code first.
   Do not shape the model to make the check pass.
3. Read a failure with the `statechart` skill: run it on `DailyDigest.tla`
   with `DailyDigest.cfg`. It gives the shortest path to the broken rule in
   plain words. Replay each step of that path against the code, for example
   as a test in `tools/cli/test/digest.test.ts` that writes to the note inside
   the `summarize` stub.
   - A step that cannot happen in the code: the model is wrong. Fix the model.
   - Every step can happen: it is a bug in the code. Report it. Never weaken
     `NoThoughtLost` to make it pass.
4. When a guard line moved or changed, update `GUARDS` in `scripts/check.ts`
   to the new line, and keep the model in step.
5. After you confirm that the model describes the code, set the sync commit
   above to the commit you checked.
