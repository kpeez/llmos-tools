---
name: verify-memory-sync
description: Model-check with TLA+ that the shared-memory Git sync and the digest push never revert remote or local work, never push a private note, and that the sync lock admits one run at a time. Use when a change touches cli/src/git.ts (publish, update, mergeDiverged, changedBetween, fastForward), syncOnStop or withLock in cli/src/hooks/sync.ts, the lock module cli/src/lock.ts, pushNotes in cli/src/digest.ts, or any other code that runs git in the vault checkout, or when `just verify-memory-sync` fails.
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
  `llmos-sync.lock.db`. Harm when it breaks: two sessions sync at the same
  time. The memory project lock and the service start lock use the same
  module, `cli/src/lock.ts`, so the rule covers them.

## Run it

From `cli/`:

```sh
just verify-memory-sync
```

The recipe runs `scripts/check.ts`. It runs each case below with TLC and
exits 0 only when every case gives its expected result and every line in
`GUARDS` (in `scripts/check.ts`) is still in `cli/src/git.ts`,
`cli/src/hooks/sync.ts`, `cli/src/lock.ts`, or `cli/src/digest.ts`.

| Case | Expected |
| --- | --- |
| Sync, the code, all rules | holds |
| Sync, the code, no lock at all (`Mutex = FALSE`) | holds |
| Sync, names mutant (`Ids = "names"`), each rule | breaks |
| Sync + digest push, the code, all rules | holds |
| Sync + digest push, the code, no lock at all (`Mutex = FALSE`) | holds |
| Sync + digest push, rebase mutant (`Digest = "rebase"`), `NoLocalLoss` | breaks |
| Sync + digest push, rebase mutant, `OnlyCheckedPush` | breaks |
| Lock, the code (`Lock = "kernel"`), 2 runs | holds |
| Lock, the code, 3 runs | holds |
| Lock, token-file mutant (`Lock = "token"`), 2 runs | holds |
| Lock, token-file mutant, 3 runs | breaks |
| Lock, rm mutant (`Lock = "rm"`), 2 runs | breaks |

Each break prints the counterexample's action names. The first run installs
Java and the pinned TLC jar with mise, and needs the network. Set `TLA2TOOLS`
and `JAVA` to use another TLC. A run takes about 45 s; the digest case
without a lock takes most of it.

## The mutants

Each mutant is the code before a fix. A mutant that breaks shows that the
check can still fail. The names and rm mutants are the code before two fixes
in `29cf240` (shared project memory, #165), whose review rounds found both
bugs.

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
- **Token-file mutant** (`Lock = "token"`): the lock before `cli/src/lock.ts`.
  A lock file created with `openSync(path, "wx")`, taken over when older
  than a limit with `renameSync` and `linkSync`, and released with a token
  check. Two runs hold it when three race over a stale lock: run A renames
  the stale lock away; run B finds no file in that moment, which the code
  did not treat as a live lock, so B goes on to rename; A creates its own
  lock, and B renames that fresh lock away; run C creates a lock before B
  links A's lock back. A and C both hold. The kernel lock has no stale
  state to judge, so it has no such path.
- **Rebase mutant** (`Digest = "rebase"`): `pushNotes` before it moved onto
  `cli/src/git.ts`. It committed its notes, ran `git pull --rebase
  --autostash`, then `git rebase --abort` when the pull failed, and ended
  with a plain `git push`. It breaks two rules:
  - `NoLocalLoss`: a Stop sync passes its gate; another host pushes; the
    digest commits its note, fetches, and the rebase detaches HEAD; the
    sync commits its memory file on the detached HEAD; the rebase
    conflicts; the abort puts `main` back. The memory commit is off every
    branch, and the abort resets its file on disk. The test "a memory commit
    made when HEAD is checked out" in `cli/test/digest.test.ts` replays it
    with real git: a `post-checkout` hook makes the sync's commit.
  - `OnlyCheckedPush`: the plain `git push` publishes every unpushed commit
    on `main`. One actor is enough: the user commits a private note, then
    the digest runs.

  A Biome plugin (`cli/lint/git-words.grit`) now fails on `rebase`,
  `--autostash`, `stash`, `reset`, or `pull` in any git argument list, and
  another (`cli/lint/git-spawn.grit`) on a git spawn outside `cli/src/git.ts`.

## Known findings

None. The code breaks no case. The old known finding, that the token lock
file admitted two runs when three raced over a stale lock, ended when the
lock moved to `cli/src/lock.ts`; the token-file mutant keeps it as a case.

## What the models cover

`MemorySync.tla` with `MemorySync.cfg` (2 sync runs, 1 local memory edit, 2
remote memory edits, 1 private note) and `MemorySyncDigest.cfg` (the same
with the digest push and 1 remote edit). The digest is one more run, `Dg`,
of the same steps as the sync, from `SCommit` on: it runs no sync gate and
takes no lock. Each action is one git call:

| Model | Code |
| --- | --- |
| `SGate` | `syncGate` (git.ts `mainCheckout`), `changedMemoryPaths`, and `hasUnpushed` before `withLock` in `syncOnStop` |
| `SLock`, `SRelease` | `withLock` (`tryLock`, `held.release()` in `cli/src/lock.ts`) as a perfect lock (`Mutex = TRUE`) or no lock (`Mutex = FALSE`) |
| `SCommit` | git.ts `add` and `commit` of the memory paths; for `Dg`, `pushNotes` in `cli/src/digest.ts`: `add`, `hasStaged`, `commit` of its notes |
| `SFetch`, `SFail` | git.ts `fetchMain`; a fetch or push failure ends the run |
| `SReadOrigin`, `SReadTip` | git.ts `fetchAndRead`: `revParse(repo, "origin/main")`, `revParse(repo, "HEAD")`, `behind`, `ahead` |
| `SFFOrigin` | git.ts `publish`: `fastForward(checkout, origin, ...)` when behind only |
| `SMergeTree`, `SCommitTree`, `SFFMerge` | git.ts `mergeDiverged`: `merge-tree`, `commit-tree -p head -p origin`, `fastForward(id)` |
| `SPush` | git.ts `publish`: `changedBetween(origin, tip)` against the run's allowed paths (memory; for `Dg` also daily notes), then `push origin <tip>:refs/heads/main` |
| `SN*` | the names mutant of the steps above |
| `RemotePush` | another host's sync pushes a memory change |
| `UserCommit`, `UserFetch` | the user or Obsidian Git commits a note or fetches |
| `DCommit` | rebase mutant: `git add`, `git diff --cached`, `git commit -- paths` |
| `DFetch`, `DRebase`, `DReplay` | rebase mutant: `git pull --rebase --autostash`: the fetch, the detach at the upstream, the replay or the conflict and `git rebase --abort` |
| `DPush` | rebase mutant: `git push` |

`SyncLock.tla` with `SyncLock.cfg` (2 runs; the mutants also start with a
stale lock of a killed run): `Create`, `Release`, and `Crash` for the code,
and one action per file-system call for the mutants.

Assumptions, which the check does not cover:

- A tree is a set of changes, each its own file, and content only grows. A
  deletion, a rename, and the content of a conflict are not modeled.
  `merge-tree` and the rebase may conflict at any step.
- The work tree, the index, and `--autostash` are not modeled. The rules are
  about commits. A conflict that `--autostash` leaves in the work tree is
  out of scope.
- `git add` plus `git commit -- paths` is one step. A pathspec commit takes
  only those paths, so another writer's staged files never enter it. Two
  writers' local calls never interleave inside one git call: git's
  `index.lock` makes a concurrent `add` or `commit` fail, which ends that
  run without a change.
- In the code the digest may push every daily note and its run note
  (`categories/Reviews.md`), not only the notes of this run, so a later run
  retries a push that failed. The model's `DigestEdits` stand for these.
  Daily notes are not private notes: the digest publishes them whole.
- The rebase mutant replays all local commits as one commit. Git may refuse
  a pathspec commit while a rebase is stopped on a conflict, so in that
  code the window of the lost commit can be shorter than in the model.
- The user never pushes. Every private note on the remote was pushed by a
  tool.
- `syncOnStart` and the cloud session start (`cli/src/hooks/cloud.ts`) are
  not modeled. Both run git.ts `update`, which only fast-forwards with
  `--ff-only` to a fixed commit ID, and that refuses rather than
  overwrites. The cloud session has no sync and no digest.
- The kernel grants an exclusive SQLite lock to one process at a time and
  drops it when the process ends. The lock file must be on a local file
  system: a network file system may not honor the lock. A holder that
  stalls keeps the lock; a waiter for the memory lock gives up after 10 s,
  and a sync run skips.
- Bounds: 2 sync runs (3 in the lock case), 1 or 2 remote edits, 1 memory
  edit, 1 private note, 1 digest run.
- The digest takes no sync lock. The case "sync + digest push, the code"
  checks it beside sync runs that serialize; the case without a lock checks
  it with no lock at all. A scratch mutant that let the digest push private
  notes broke `OnlyCheckedPush` through `Dg`'s own steps, so these cases do
  reach the digest's push.

Sync commit: `ee06f0f` (refactor(lock): take every lock from the kernel
through one module). At that commit, the models describe the code.

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
   here. Keep the code before the fix as a mutant case that breaks.
5. When a guard line moved or changed, update `GUARDS` in `scripts/check.ts`
   to the new line, and keep the model in step.
6. After you confirm that the models describe the code, set the sync commit
   above to the commit you checked.
