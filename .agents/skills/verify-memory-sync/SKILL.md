---
name: verify-memory-sync
description: Model-check with TLA+ that the shared-memory Git sync never reverts remote or local work, never pushes a private note, and that its lock admits one run at a time. Use when a change touches syncOnStop, mergeDiverged, otherAheadPaths, fastForward, or the lock (acquire, release, withLock) in cli/src/hooks/sync.ts, or pushNotes in cli/src/digest.ts, or any other code that runs git in the vault checkout, or when `just verify-memory-sync` fails.
---

# Verify the shared-memory Git sync

## The rules

- `NoRemoteRevert`: the remote `main` holds every change of every commit in
  its history. Harm when it breaks: a sync push silently undoes memory that
  another host pushed.
- `NoLocalLoss`: every change in any commit made in the vault checkout stays
  in local `main` or on the remote. Harm when it breaks: a memory commit or a
  note commit disappears from the branch, and its file from the disk.
- `OnlyCheckedPush`: the remote never receives a private note that the user
  did not push. Harm when it breaks: a note the user kept local is published.
- `MutualExclusion` (`SyncLock.tla`): at most one run works under
  `llmos-sync.lock`. Harm when it breaks: two sessions sync at the same time.

## Run it

From `cli/`:

```sh
just verify-memory-sync
```

The recipe runs `scripts/check.ts`. It runs each case below with TLC and
exits 0 only when every case gives its expected result and every line in
`GUARDS` (in `scripts/check.ts`) is still in `cli/src/hooks/sync.ts` or
`cli/src/digest.ts`.

| Case | Expected |
| --- | --- |
| Sync, the code, all rules | holds |
| Sync, the code, no lock at all (`Mutex = FALSE`) | holds |
| Sync, names mutant (`Ids = "names"`), each rule | breaks |
| Sync + digest push, the code, `NoRemoteRevert` | holds |
| Sync + digest push, the code, `NoLocalLoss` | breaks: known finding 1 |
| Sync + digest push, the code, `OnlyCheckedPush` | breaks: known finding 2 |
| Lock, the code, 2 runs | holds |
| Lock, rm mutant (`Lock = "rm"`), 2 runs | breaks |
| Lock, the code, 3 runs | breaks: known finding 3 |

Each break prints the counterexample's action names. The first run installs
Java and the pinned TLC jar with mise, and needs the network. Set `TLA2TOOLS`
and `JAVA` to use another TLC. A run takes about 15 s.

## The mutants

Each mutant is the code before a fix in `29cf240` (shared project memory,
#165), whose review rounds found both bugs. A mutant that breaks shows that
the check can still fail.

- **Names mutant** (`Ids = "names"`): every git call resolved the names
  `HEAD` and `origin/main` again when it ran, and the push was
  `push origin HEAD:main`. Shortest break of `NoRemoteRevert`: the sync
  writes the merge tree from `origin/main`; another host pushes; a fetch
  moves `origin/main`; `commit-tree -p HEAD -p origin/main` makes a merge
  whose parent has the new remote change and whose tree does not; the push
  is a fast-forward, so the remote takes it. A commit that lands after
  `otherAheadPaths` and before `push HEAD:main` is published unchecked
  (`OnlyCheckedPush`).
- **Rm mutant** (`Lock = "rm"`): a stale lock was removed with
  `rmSync(path)`, and release removed the lock file whoever owned it. Two
  runs both see a stale lock; one removes it and creates its own; the other
  then removes that fresh lock and creates its own. Both hold the lock.

## Known findings

The code breaks these cases. They stay findings until the code changes. Do
not weaken a rule or the model to make them pass.

1. **The digest push drops a commit made during its rebase.** `pushNotes`
   runs `git pull --rebase --autostash` and, when it fails, `git rebase
   --abort`. Trace: a Stop sync passes its gate; another host pushes; the
   digest commits its note, fetches, and the rebase detaches HEAD; the sync
   commits its memory file on the detached HEAD; the rebase conflicts; the
   abort puts `main` back. The memory commit is off every branch, and the
   abort resets its file on disk. Replayed with real git: a `post-checkout`
   hook made the sync's commit when the rebase detached HEAD.
2. **The digest push publishes private notes.** `pushNotes` ends with a
   plain `git push`, which publishes every unpushed commit on `main`. The
   sync refuses to push them (`otherAheadPaths`); the digest does not. One
   actor is enough: the user commits a private note, then the digest runs.
3. **The token lock admits two runs when three race over a stale lock.** Run
   A renames the stale lock away. Run B's `statSafe(path)` finds no file in
   that moment, which `acquire` does not treat as a live lock, so B goes on
   to `renameSync`. A creates its own lock, and B renames that fresh lock
   away. Run C creates a lock before B links A's lock back. A and C both
   hold. The case "Sync,
   no lock at all" shows that the data rules hold even then: the fixed
   commit IDs and `--ff-only` refuse instead of overwriting.

## What the models cover

`MemorySync.tla` with `MemorySync.cfg` (2 sync runs, 1 local memory edit, 2
remote memory edits, 1 private note) and `MemorySyncDigest.cfg` (the same
with the digest push and 1 remote edit). Each action is one git call:

| Model | Code (`cli/src/hooks/sync.ts` unless named) |
| --- | --- |
| `SGate` | `syncGate`, `changedMemoryPaths`, and `count(origin/main..HEAD)` before `withLock` in `syncOnStop` |
| `SLock`, `SRelease` | `withLock` as a perfect lock (`Mutex = TRUE`) or no lock (`Mutex = FALSE`) |
| `SCommit` | `git add -A -- paths` and `git commit -- paths` |
| `SFetch`, `SFail` | `fetch`; a fetch or push failure returns with `warn` |
| `SReadOrigin`, `SReadTip` | `revParse(... "origin/main")`, `revParse(... "HEAD")`, `behind`, `ahead` |
| `SFFOrigin` | `fastForward(gate, env, origin, ...)` when behind only |
| `SMergeTree`, `SCommitTree`, `SFFMerge` | `mergeDiverged`: `merge-tree`, `commit-tree -p head -p origin`, `fastForward(id)` |
| `SPush` | `otherAheadPaths(origin, tip)`, then `push origin <tip>:refs/heads/main` |
| `SN*` | the names mutant of the steps above |
| `RemotePush` | another host's sync pushes a memory change |
| `UserCommit`, `UserFetch` | the user or Obsidian Git commits a note or fetches |
| `DCommit` | `pushNotes` in `cli/src/digest.ts`: `git add`, `git diff --cached`, `git commit -- paths` |
| `DFetch`, `DRebase`, `DReplay` | `git pull --rebase --autostash`: the fetch, the detach at the upstream, the replay or the conflict and `git rebase --abort` |
| `DPush` | `git push` |

`SyncLock.tla` with `SyncLock.cfg` (2 runs, and in some initial states a
stale lock of a killed run): `create`, `acquire`, and `release`, one action
per file-system call.

Assumptions, which the check does not cover:

- A tree is a set of changes, each its own file, and content only grows. A
  deletion, a rename, and the content of a conflict are not modeled.
  `merge-tree` and the rebase may conflict at any step.
- The work tree, the index, and `--autostash` are not modeled. The rules are
  about commits. A conflict that `--autostash` leaves in the work tree is
  out of scope.
- `git add` plus `git commit -- paths` is one step. A pathspec commit takes
  only those paths, so another writer's staged files never enter it.
- A rebase replays all local commits as one commit. Git may refuse a
  pathspec commit while a rebase is stopped on a conflict, so in the code
  the window of finding 1 can be shorter than in the model.
- The user never pushes. Every private note on the remote was pushed by a
  tool.
- `syncOnStart` is not modeled. It runs under the same lock, and it only
  fast-forwards with `--ff-only`, which refuses rather than overwrites.
- A lock is stale only when its run is gone: a hook runs at most 30 s and a
  lock goes stale after 60 s. A suspended laptop can break this.
- Bounds: 2 sync runs (3 in the lock case), 1 or 2 remote edits, 1 memory
  edit, 1 private note, 1 digest run.

Sync commit: `91504b6` (feat(hooks): have the cloud agent attach the vault
itself). At that commit, the models describe the code.

## When a change touches the covered code

1. Run `just verify-memory-sync` before and after the change.
2. Read the code change against the table above. When a step changed shape,
   such as a new git call, a name read again where an ID was fixed, a new
   writer of the vault checkout, or a change to the lock, change the model
   to describe the new code first. Do not shape the model to make the check
   pass.
3. Read every result with the `statechart` skill on the `.tla` file and the
   case's constants. For a break, it gives the shortest path to the broken
   rule in plain words. Replay each step of that path against the code, for
   example as a test in `cli/test/hooks/sync.test.ts` with a bare origin and
   two clones, or with a git hook that runs a step inside another git call.
   - A step that cannot happen in the code: the model is wrong. Fix it.
   - Every step can happen: it is a bug in the code. Report it. Never weaken
     a rule to make it pass.
4. When a fix ends a known finding, the check fails with "the finding no
   longer reproduces". Confirm the fix, then set that case to `holds` in
   `CASES` in `scripts/check.ts`, and update the table and the findings
   here. When `pushNotes` stops rebasing, its `GUARDS` lines go away:
   change `DFetch`, `DRebase`, `DReplay`, and `DPush` to the new calls.
5. When a guard line moved or changed, update `GUARDS` in `scripts/check.ts`
   to the new line, and keep the model in step.
6. After you confirm that the models describe the code, set the sync commit
   above to the commit you checked.
