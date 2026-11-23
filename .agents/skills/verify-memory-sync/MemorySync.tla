----------------------------- MODULE MemorySync -----------------------------
(***************************************************************************)
(* The Stop memory sync (`syncOnStop` in cli/src/hooks/sync.ts, through   *)
(* `publish` in cli/src/git.ts) in one vault checkout, with the other      *)
(* writers of that checkout and its remote.                                *)
(*                                                                         *)
(* A commit is a set of parents and a tree. A tree is the set of changes   *)
(* it holds; every change is its own file, and content only grows, so a    *)
(* change missing from a later tree was reverted.                          *)
(*                                                                         *)
(* Actors, each action one git call:                                       *)
(*   Sync runs (Runs): syncOnStop in two sessions on this host.            *)
(*   The remote host: another host pushes a memory change to `main`.       *)
(*   The user (or Obsidian Git): commits a private note on `main`, and     *)
(*     fetches `origin main`. The user never pushes in this model, so any  *)
(*     private change on the remote was pushed by a tool.                  *)
(*   The digest push, `pushNotes` in cli/src/digest.ts. It takes no sync *)
(*     lock.                                                               *)
(*     Digest = "publish" is the code: the run Dg commits its notes, then  *)
(*     runs the sync's own steps (git.ts `publish`), which may push only   *)
(*     daily notes and memory.                                             *)
(*     Digest = "rebase" is the code before git.ts, kept as a mutant: add  *)
(*     and commit, `git pull --rebase --autostash` (a fetch, then a rebase *)
(*     that detaches HEAD, replays the local commits, and moves `main`),   *)
(*     `git rebase --abort` when the pull fails, and a plain `git push`.   *)
(*     Digest = "none": no digest.                                         *)
(*                                                                         *)
(* Ids = "fixed" is the code: `syncOnStop` reads `origin/main` and `HEAD`  *)
(* once and uses those IDs for every later step. Ids = "names" is the code *)
(* before the fix that pinned the IDs, kept as a mutant: each git call     *)
(* resolves the names `HEAD` and `origin/main` again when it runs, and the *)
(* check of unpushed commits reads `git log --no-merges` only.             *)
(*                                                                         *)
(* Mutex = TRUE takes `withLock` as a perfect lock (sync runs serialize).  *)
(* Mutex = FALSE drops the lock, so two sync runs interleave freely. The   *)
(* lock itself is modeled in SyncLock.tla.                                 *)
(*                                                                         *)
(* Assumptions (see SKILL.md for the full list):                           *)
(*   - `git add` + `git commit -- paths` is one step; a pathspec commit    *)
(*     takes only those paths, so another writer's staged files never     *)
(*     enter it.                                                           *)
(*   - The work tree, the index, and `--autostash` are not modeled: the    *)
(*     invariants are about commits.                                       *)
(*   - `merge-tree` and the rebase may conflict at any time (a             *)
(*     nondeterministic choice). Fetch, merge-tree, and push may fail at   *)
(*     any time; a failure ends the run, as every `warn` + `return` does.  *)
(*   - A rebase replays all local commits as one new commit.               *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Runs,          \* sync runs (sessions) on this host
          MemEdits,      \* memory changes in this host's work tree
          RemoteEdits,   \* memory changes another host pushes
          PrivateEdits,  \* private notes the user commits and never pushes
          DigestEdits,   \* daily notes the digest commits and pushes
          Digest,        \* "none", "publish" (the code), or "rebase" (the mutant)
          Ids,           \* "fixed" (the code) or "names" (the mutant)
          Mutex          \* TRUE: sync runs hold a perfect lock

Memory == MemEdits \cup RemoteEdits
None == 0      \* no commit
NoRun == "none" \* no run holds the lock
Dg == "digest" \* the digest's run of the publish steps (Digest = "publish")
\* Every run of the publish steps: the sync runs, and the digest's.
Procs == IF Digest = "publish" THEN Runs \cup {Dg} ELSE Runs
\* What a run may push: memory for the sync, also daily notes for the digest.
Allowed(r) == IF r = Dg THEN Memory \cup DigestEdits ELSE Memory

VARIABLES cs,          \* the commits: cs[i] = [par |-> parents, tree |-> changes]
          remote,      \* `main` on the remote
          tracking,    \* the local `origin/main`
          branch,      \* the local `refs/heads/main`
          detached,    \* HEAD while a rebase runs, else None
          wtMem,       \* memory changes in the work tree, not yet committed
          made,        \* changes that a writer has made (each one once)
          holder,      \* the run that holds the sync lock, or NoRun
          spc,         \* each run's next call (sync runs and Dg)
          paths,       \* `changedMemoryPaths` that a run read before the lock
          origin,      \* the `origin/main` ID a run read
          tip,         \* the `HEAD` ID a run read, then its merge
          mtree,       \* the tree `merge-tree` wrote
          mid,         \* the commit `commit-tree` made
          dpc,         \* the rebase mutant's next call
          dorig,       \* the branch commit when the mutant's rebase started
          dup          \* the upstream commit the mutant's pull fetched

syncVars == <<spc, paths, origin, tip, mtree, mid>>
vars == <<cs, remote, tracking, branch, detached, wtMem, made, holder,
          syncVars, dpc, dorig, dup>>

HEAD == IF detached # None THEN detached ELSE branch

RECURSIVE Anc(_)
Anc(c) == {c} \cup UNION {Anc(p) : p \in cs[c].par}

Tree(c) == cs[c].tree
IsMerge(c) == Cardinality(cs[c].par) > 1
\* What a non-merge commit changed against its parent.
Chg(c) == Tree(c) \ UNION {Tree(p) : p \in cs[c].par}
\* `git rev-list --count a..b` > 0
Count(a, b) == Anc(b) \ Anc(a) # {}

\* `changedBetween(base, tip)` in `publish`: paths outside what run r may
\* push that the non-merge commits base..tip touch, and (Ids = "fixed") the
\* net diff base tip.
Others(r, b, t) ==
  LET log == UNION {Chg(c) : c \in {x \in Anc(t) \ Anc(b) : ~IsMerge(x)}}
      net == (Tree(t) \ Tree(b)) \cup (Tree(b) \ Tree(t))
  IN (IF Ids = "fixed" THEN log \cup net ELSE log) \ Allowed(r)

NewId == Len(cs) + 1
AddCommit(ps, t) == cs' = Append(cs, [par |-> ps, tree |-> t])

\* Move HEAD: the detached HEAD during a rebase, else `main`.
SetHead(c) == IF detached # None
              THEN detached' = c /\ UNCHANGED branch
              ELSE branch' = c /\ UNCHANGED detached

\* The remote accepts a push only as a fast-forward.
CanPush(c) == remote \in Anc(c)

Init ==
  /\ cs = <<[par |-> {}, tree |-> {}]>>
  /\ remote = 1 /\ tracking = 1 /\ branch = 1 /\ detached = None
  /\ wtMem = MemEdits /\ made = MemEdits
  /\ holder = NoRun
  \* Dg starts at its commit: the digest runs no sync gate and takes no lock.
  /\ spc = [r \in Procs |-> IF r = Dg THEN "commit" ELSE "gate"]
  /\ paths = [r \in Procs |-> {}]
  /\ origin = [r \in Procs |-> None] /\ tip = [r \in Procs |-> None]
  /\ mtree = [r \in Procs |-> {}] /\ mid = [r \in Procs |-> None]
  /\ dpc = IF Digest = "rebase" THEN "commit" ELSE "done"
  /\ dorig = None /\ dup = None

----------------------------------------------------------------------------
(* syncOnStop *)

SGo(r, l) == spc' = [spc EXCEPT ![r] = l]
\* Every `warn` + `return` inside `withLock`, and the end of the work.
SEnd(r) == SGo(r, "release")

\* `syncGate` (branch is `main`, no rebase marker), then `changedMemoryPaths`
\* and `count(origin/main..HEAD)`, all before the lock.
SGate(r) ==
  /\ spc[r] = "gate"
  /\ IF detached # None \/ (wtMem = {} /\ ~Count(tracking, HEAD))
     THEN SGo(r, "done") /\ UNCHANGED paths
     ELSE /\ paths' = [paths EXCEPT ![r] = wtMem]
          /\ SGo(r, "lock")
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, holder,
                 origin, tip, mtree, mid, dpc, dorig, dup>>

SLock(r) ==
  /\ spc[r] = "lock"
  /\ IF ~Mutex THEN SGo(r, "commit") /\ UNCHANGED holder
     ELSE IF holder = NoRun
          THEN holder' = r /\ SGo(r, "commit")
          ELSE SGo(r, "done") /\ UNCHANGED holder   \* another run holds it: skip
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, paths,
                 origin, tip, mtree, mid, dpc, dorig, dup>>

\* `git add -A -- paths` + `git commit -- paths`; it fails when none of the
\* paths changed any more (another run committed them). For Dg: `pushNotes`
\* writes its notes, then `add`, `hasStaged`, and `commit` them.
SCommit(r) ==
  /\ spc[r] = "commit"
  /\ IF r = Dg
     THEN /\ AddCommit({HEAD}, Tree(HEAD) \cup DigestEdits)
          /\ SetHead(NewId)
          /\ made' = made \cup DigestEdits
          /\ SGo(r, "fetch")
          /\ UNCHANGED wtMem
     ELSE /\ IF paths[r] = {} THEN SGo(r, "fetch") /\ UNCHANGED <<cs, branch, detached, wtMem>>
             ELSE IF paths[r] \cap wtMem = {}
             THEN SEnd(r) /\ UNCHANGED <<cs, branch, detached, wtMem>>
             ELSE /\ AddCommit({HEAD}, Tree(HEAD) \cup (paths[r] \cap wtMem))
                  /\ SetHead(NewId)
                  /\ wtMem' = wtMem \ paths[r]
                  /\ SGo(r, "fetch")
          /\ UNCHANGED made
  /\ UNCHANGED <<remote, tracking, holder, paths, origin, tip, mtree, mid,
                 dpc, dorig, dup>>

\* `git fetch origin main`. The names mutant is a sync mutant: Dg runs the code.
SFetch(r) ==
  /\ spc[r] = "fetch"
  /\ tracking' = remote
  /\ SGo(r, IF Ids = "fixed" \/ r = Dg THEN "readOrigin" ELSE "nBehind")
  /\ UNCHANGED <<cs, remote, branch, detached, wtMem, made, holder, paths,
                 origin, tip, mtree, mid, dpc, dorig, dup>>

\* --- Ids = "fixed": the code ------------------------------------------------

\* `const origin = revParse(repo, "origin/main");` in git.ts `fetchAndRead`
SReadOrigin(r) ==
  /\ spc[r] = "readOrigin"
  /\ origin' = [origin EXCEPT ![r] = tracking]
  /\ SGo(r, "readTip")
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, holder,
                 paths, tip, mtree, mid, dpc, dorig, dup>>

\* `const tip = revParse(repo, "HEAD");` then `behind` and `ahead`, which
\* count between the two fixed IDs, so no other writer can change them.
SReadTip(r) ==
  /\ spc[r] = "readTip"
  /\ tip' = [tip EXCEPT ![r] = HEAD]
  /\ LET o == origin[r]
         behind == Count(HEAD, o)
         ahead == Count(o, HEAD)
     IN SGo(r, IF behind /\ ~ahead THEN "ffOrigin"
               ELSE IF ~ahead THEN "release"
               ELSE IF behind THEN "mergeTree"
               ELSE "push")
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, holder,
                 paths, origin, mtree, mid, dpc, dorig, dup>>

\* `git merge --ff-only <target>`: it refuses unless HEAD is an ancestor.
FF(target) == IF HEAD \in Anc(target) THEN SetHead(target) ELSE UNCHANGED <<branch, detached>>

SFFOrigin(r) ==
  /\ spc[r] = "ffOrigin"
  /\ FF(origin[r])
  /\ SEnd(r)
  /\ UNCHANGED <<cs, remote, tracking, wtMem, made, holder, paths, origin, tip,
                 mtree, mid, dpc, dorig, dup>>

\* `merge-tree --write-tree origin head`; a conflict returns.
SMergeTree(r) ==
  /\ spc[r] = "mergeTree"
  /\ \/ /\ mtree' = [mtree EXCEPT ![r] = Tree(origin[r]) \cup Tree(tip[r])]
        /\ SGo(r, "commitTree")
     \/ SEnd(r) /\ UNCHANGED mtree
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, holder,
                 paths, origin, tip, mid, dpc, dorig, dup>>

\* `commit-tree <tree> -p head -p origin`
SCommitTree(r) ==
  /\ spc[r] = "commitTree"
  /\ AddCommit({tip[r], origin[r]}, mtree[r])
  /\ mid' = [mid EXCEPT ![r] = NewId]
  /\ SGo(r, "ffMerge")
  /\ UNCHANGED <<remote, tracking, branch, detached, wtMem, made, holder, paths,
                 origin, tip, mtree, dpc, dorig, dup>>

\* `fastForward(id)`; on success `tip = merged.id`.
SFFMerge(r) ==
  /\ spc[r] = "ffMerge"
  /\ IF HEAD \in Anc(mid[r])
     THEN SetHead(mid[r]) /\ tip' = [tip EXCEPT ![r] = mid[r]] /\ SGo(r, "push")
     ELSE SEnd(r) /\ UNCHANGED <<branch, detached, tip>>
  /\ UNCHANGED <<cs, remote, tracking, wtMem, made, holder, paths, origin,
                 mtree, mid, dpc, dorig, dup>>

\* `changedBetween(origin, tip)`, then `push origin <tip>:refs/heads/main`.
\* The check reads fixed IDs only, so it is part of this step. A push that
\* succeeds also moves the local `origin/main`.
SPush(r) ==
  /\ spc[r] = "push"
  /\ IF Others(r, origin[r], tip[r]) = {} /\ CanPush(tip[r])
     THEN \/ remote' = tip[r] /\ tracking' = tip[r]
          \/ UNCHANGED <<remote, tracking>>           \* the push fails
     ELSE UNCHANGED <<remote, tracking>>
  /\ SEnd(r)
  /\ UNCHANGED <<cs, branch, detached, wtMem, made, holder, paths, origin, tip,
                 mtree, mid, dpc, dorig, dup>>

\* --- Ids = "names": the mutant, each call resolves HEAD and origin/main ---

\* `count(gate, env, "HEAD..origin/main") > 0`
SNBehind(r) ==
  /\ spc[r] = "nBehind"
  /\ SGo(r, IF Count(HEAD, tracking) THEN "nAhead" ELSE "nCheck")
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, holder,
                 paths, origin, tip, mtree, mid, dpc, dorig, dup>>

\* `count(gate, env, "origin/main..HEAD") > 0 ? mergeDiverged : fastForward`
SNAhead(r) ==
  /\ spc[r] = "nAhead"
  /\ SGo(r, IF Count(tracking, HEAD) THEN "nMergeTree" ELSE "nFF")
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, holder,
                 paths, origin, tip, mtree, mid, dpc, dorig, dup>>

\* `fastForward(gate, env, "origin/main", ...)`
SNFF(r) ==
  /\ spc[r] = "nFF"
  /\ IF HEAD \in Anc(tracking)
     THEN SetHead(tracking) /\ SGo(r, "nCheck")
     ELSE SEnd(r) /\ UNCHANGED <<branch, detached>>
  /\ UNCHANGED <<cs, remote, tracking, wtMem, made, holder, paths, origin, tip,
                 mtree, mid, dpc, dorig, dup>>

\* `merge-tree --write-tree origin/main HEAD`
SNMergeTree(r) ==
  /\ spc[r] = "nMergeTree"
  /\ \/ /\ mtree' = [mtree EXCEPT ![r] = Tree(tracking) \cup Tree(HEAD)]
        /\ SGo(r, "nCommitTree")
     \/ SEnd(r) /\ UNCHANGED mtree
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, holder,
                 paths, origin, tip, mid, dpc, dorig, dup>>

\* `commit-tree <tree> -p HEAD -p origin/main`
SNCommitTree(r) ==
  /\ spc[r] = "nCommitTree"
  /\ AddCommit({HEAD, tracking}, mtree[r])
  /\ mid' = [mid EXCEPT ![r] = NewId]
  /\ SGo(r, "nFFMerge")
  /\ UNCHANGED <<remote, tracking, branch, detached, wtMem, made, holder, paths,
                 origin, tip, mtree, dpc, dorig, dup>>

SNFFMerge(r) ==
  /\ spc[r] = "nFFMerge"
  /\ IF HEAD \in Anc(mid[r])
     THEN SetHead(mid[r]) /\ SGo(r, "nCheck")
     ELSE SEnd(r) /\ UNCHANGED <<branch, detached>>
  /\ UNCHANGED <<cs, remote, tracking, wtMem, made, holder, paths, origin, tip,
                 mtree, mid, dpc, dorig, dup>>

\* `otherAheadPaths`: `git log --no-merges origin/main..HEAD`
SNCheck(r) ==
  /\ spc[r] = "nCheck"
  /\ SGo(r, IF Others(r, tracking, HEAD) = {} THEN "nPush" ELSE "release")
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, holder,
                 paths, origin, tip, mtree, mid, dpc, dorig, dup>>

\* `push origin HEAD:main`
SNPush(r) ==
  /\ spc[r] = "nPush"
  /\ IF CanPush(HEAD)
     THEN \/ remote' = HEAD /\ tracking' = HEAD
          \/ UNCHANGED <<remote, tracking>>
     ELSE UNCHANGED <<remote, tracking>>
  /\ SEnd(r)
  /\ UNCHANGED <<cs, branch, detached, wtMem, made, holder, paths, origin, tip,
                 mtree, mid, dpc, dorig, dup>>

\* A fetch or a push that fails (or times out) returns with a warning.
SFail(r) ==
  /\ spc[r] \in {"fetch", "push", "nPush"}
  /\ SEnd(r)
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, holder,
                 paths, origin, tip, mtree, mid, dpc, dorig, dup>>

\* `release` in `withLock`'s finally. Dg holds no lock, so it releases none.
SRelease(r) ==
  /\ spc[r] = "release"
  /\ holder' = IF holder = r THEN NoRun ELSE holder
  /\ SGo(r, "done")
  /\ UNCHANGED <<cs, remote, tracking, branch, detached, wtMem, made, paths,
                 origin, tip, mtree, mid, dpc, dorig, dup>>

SyncStep(r) ==
  \/ SGate(r) \/ SLock(r) \/ SCommit(r) \/ SFetch(r)
  \/ SReadOrigin(r) \/ SReadTip(r) \/ SFFOrigin(r) \/ SMergeTree(r)
  \/ SCommitTree(r) \/ SFFMerge(r) \/ SPush(r)
  \/ SNBehind(r) \/ SNAhead(r) \/ SNFF(r) \/ SNMergeTree(r)
  \/ SNCommitTree(r) \/ SNFFMerge(r) \/ SNCheck(r) \/ SNPush(r)
  \/ SFail(r) \/ SRelease(r)

----------------------------------------------------------------------------
(* The other writers *)
(* The rebase mutant (Digest = "rebase") is the D* actions below. *)

\* Another host pushes a memory change to the remote `main`.
RemotePush(e) ==
  /\ e \in RemoteEdits \ made
  /\ AddCommit({remote}, Tree(remote) \cup {e})
  /\ remote' = NewId
  /\ made' = made \cup {e}
  /\ UNCHANGED <<tracking, branch, detached, wtMem, holder, syncVars, dpc, dorig, dup>>

\* The user commits a private note on whatever HEAD is.
UserCommit(e) ==
  /\ e \in PrivateEdits \ made
  /\ AddCommit({HEAD}, Tree(HEAD) \cup {e})
  /\ SetHead(NewId)
  /\ made' = made \cup {e}
  /\ UNCHANGED <<remote, tracking, wtMem, holder, syncVars, dpc, dorig, dup>>

\* The user, Obsidian Git, or session start fetches `origin main`.
UserFetch ==
  /\ tracking # remote
  /\ tracking' = remote
  /\ UNCHANGED <<cs, remote, branch, detached, wtMem, made, holder, syncVars,
                 dpc, dorig, dup>>

DGo(l) == dpc' = l
DUnchangedSync == UNCHANGED <<wtMem, holder, syncVars>>

\* `git add -- paths`, `git diff --cached --quiet`, `git commit -- paths`
DCommit ==
  /\ dpc = "commit"
  /\ AddCommit({HEAD}, Tree(HEAD) \cup DigestEdits)
  /\ SetHead(NewId)
  /\ made' = made \cup DigestEdits
  /\ DGo("fetch")
  /\ UNCHANGED <<remote, tracking, dorig, dup>> /\ DUnchangedSync

\* `git pull --rebase --autostash`, first half: the fetch.
DFetch ==
  /\ dpc = "fetch"
  /\ tracking' = remote /\ dup' = remote
  /\ DGo("rebase")
  /\ UNCHANGED <<cs, remote, branch, detached, made, dorig>> /\ DUnchangedSync

\* The rebase starts: HEAD detaches at the upstream, unless `main` already
\* holds the upstream ("Current branch main is up to date").
DRebase ==
  /\ dpc = "rebase"
  /\ IF dup \in Anc(branch)
     THEN DGo("push") /\ UNCHANGED <<detached, dorig>>
     ELSE /\ dorig' = branch /\ detached' = dup
          /\ DGo("replay")
  /\ UNCHANGED <<cs, remote, tracking, branch, made, dup>> /\ DUnchangedSync

\* The rebase replays the non-merge commits of dorig that the upstream lacks
\* onto HEAD and moves `main` there. Or it conflicts, the pull fails, and
\* the digest runs `git rebase --abort`: HEAD goes back to `main`, and the
\* digest throws.
DReplay ==
  /\ dpc = "replay"
  /\ LET picks == UNION {Chg(c) : c \in {x \in Anc(dorig) \ Anc(dup) : ~IsMerge(x)}}
     IN \/ /\ IF picks \subseteq Tree(detached)
              THEN branch' = detached /\ UNCHANGED cs
              ELSE /\ AddCommit({detached}, Tree(detached) \cup picks)
                   /\ branch' = NewId
           /\ DGo("push")
        \/ /\ picks # {}
           /\ UNCHANGED <<cs, branch>>
           /\ DGo("done")
  /\ detached' = None
  /\ UNCHANGED <<remote, tracking, made, dorig, dup>> /\ DUnchangedSync

\* `git push` of `main` to its upstream.
DPush ==
  /\ dpc = "push"
  /\ IF CanPush(branch)
     THEN \/ remote' = branch /\ tracking' = branch
          \/ UNCHANGED <<remote, tracking>>
     ELSE UNCHANGED <<remote, tracking>>
  /\ DGo("done")
  /\ UNCHANGED <<cs, branch, detached, made, dorig, dup>> /\ DUnchangedSync

DigestStep == DCommit \/ DFetch \/ DRebase \/ DReplay \/ DPush

----------------------------------------------------------------------------

Finished == /\ \A r \in Procs : spc[r] = "done"
            /\ dpc = "done"
            /\ UNCHANGED vars

Next == \/ \E r \in Procs : SyncStep(r)
        \/ \E e \in RemoteEdits : RemotePush(e)
        \/ \E e \in PrivateEdits : UserCommit(e)
        \/ UserFetch
        \/ DigestStep
        \/ Finished

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* The rules *)

(* No change is reverted on the remote `main`: its tree holds every change
   of every commit in its history. Pushes are fast-forwards, so every commit
   the remote `main` ever named is in that history. *)
NoRemoteRevert == \A c \in Anc(remote) : Tree(c) \subseteq Tree(remote)

(* No local commit is lost or reverted: when no rebase runs, every change in
   any commit ever made is in `main` or on the remote. *)
NoLocalLoss ==
  detached = None =>
    UNION {Tree(c) : c \in DOMAIN cs} \subseteq Tree(branch) \cup Tree(remote)

(* The remote never receives a private note: the user never pushes here. *)
OnlyCheckedPush == Tree(remote) \cap PrivateEdits = {}

TypeOK == /\ remote \in 1..Len(cs) /\ tracking \in 1..Len(cs)
          /\ branch \in 1..Len(cs) /\ detached \in 0..Len(cs)
=============================================================================
