------------------------------ MODULE SyncLock ------------------------------
(***************************************************************************)
(* The lock of `withLock` in cli/src/hooks/sync.ts, which takes it around  *)
(* every sync run. The memory project lock in cli/src/memory.ts and the    *)
(* service start lock in cli/src/service.ts take the same lock             *)
(* (cli/src/lock.ts), so this model covers them too.                       *)
(*                                                                         *)
(* Lock = "kernel" is the code: `tryLock` in cli/src/lock.ts, an exclusive *)
(* SQLite transaction on `llmos-sync.lock.db`. The kernel grants it to one *)
(* process and drops it when that process ends or crashes.                 *)
(*   Create    `tryLock`: `BEGIN EXCLUSIVE`; SQLITE_BUSY -> skip           *)
(*   Release   `held.release()`: `db.close()`                              *)
(*   Crash     the holder dies; the kernel drops the lock                  *)
(*                                                                         *)
(* Lock = "token" is the lock before the kernel lock, kept as a mutant:    *)
(* a lock file `llmos-sync.lock`, one file-system call per action:         *)
(*   Create      `openSync(path, "wx")` and `writeSync(token)`             *)
(*   Stat        `statSafe(path)`, fresh lock -> return null               *)
(*   Rename      `renameSync(path, taken)`                                 *)
(*   StatTaken   `statSafe(taken)`                                         *)
(*   LinkBack    `linkSync(taken, path)` (live lock taken)                 *)
(*   RmTaken     `rmSync(taken)`                                           *)
(*   ReadOwn     `readFileSync(path) === token`                            *)
(*   RmPath      `rmSync(path)`                                            *)
(* Lock = "rm" is the lock before tokens: a stale lock is removed with     *)
(* `rmSync(path)` without a check that it is still the stale file, and     *)
(* release removes the lock file whoever owns it.                          *)
(*                                                                         *)
(* Assumptions:                                                            *)
(*   - The kernel grants an exclusive SQLite lock to one process at a      *)
(*     time, also to a process that stalls, and drops it at process end.   *)
(*     A crashed holder's lock is gone, so "kernel" has no orphan.         *)
(*     The lock file must be on a local file system.                       *)
(*   - For the mutants, a lock file is stale only when its run is gone     *)
(*     (killed by the hook timeout). Hooks run at most 30 s, the stale age *)
(*     is 60 s, so a live run's lock is always fresh. The killed run's     *)
(*     lock is "orphan".                                                   *)
(*   - `create` is one step. `openSync` sets the mtime, and only `release` *)
(*     reads the content, comparing it with its own token, so an empty     *)
(*     file between open and write cannot match.                           *)
(*   - Each run acquires once, does its work at "hold", and releases.      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Runs, Lock

NoFile == "none"
Files == Runs \cup {"orphan"}
Stale(f) == f = "orphan"

VARIABLES path,     \* the file at `llmos-sync.lock`, or NoFile
          taken,    \* taken[r]: the file at run r's unique rename target
          pc,       \* each run's next call
          attempt   \* each run's loop counter in `acquire` (0 or 1)

vars == <<path, taken, pc, attempt>>

Init == /\ path \in IF Lock = "kernel" THEN {NoFile} ELSE {NoFile, "orphan"}
        /\ taken = [r \in Runs |-> NoFile]
        /\ pc = [r \in Runs |-> "create"]
        /\ attempt = [r \in Runs |-> 0]

Goto(r, l) == pc' = [pc EXCEPT ![r] = l]

\* `continue` in the loop: try `create` again, or give up after 2 attempts.
NextAttempt(r) ==
  IF attempt[r] = 0
  THEN /\ attempt' = [attempt EXCEPT ![r] = 1] /\ Goto(r, "create")
  ELSE /\ UNCHANGED attempt /\ Goto(r, "done")

Create(r) ==
  /\ pc[r] = "create"
  /\ IF path = NoFile
     THEN path' = r /\ Goto(r, "hold")
     ELSE UNCHANGED path /\ Goto(r, IF Lock = "kernel" THEN "done" ELSE "stat")
  /\ UNCHANGED <<taken, attempt>>

Stat(r) ==
  /\ pc[r] = "stat"
  /\ IF path # NoFile /\ ~Stale(path)
     THEN Goto(r, "done")                       \* a live lock: skip
     ELSE Goto(r, IF Lock = "token" THEN "rename" ELSE "rmStale")
  /\ UNCHANGED <<path, taken, attempt>>

\* Lock = "rm": `rmSync(path)` removes whatever file is there now.
RmStale(r) ==
  /\ pc[r] = "rmStale"
  /\ path' = NoFile
  /\ NextAttempt(r)
  /\ UNCHANGED taken

Rename(r) ==
  /\ pc[r] = "rename"
  /\ IF path = NoFile
     THEN /\ UNCHANGED <<path, taken>> /\ NextAttempt(r)
     ELSE /\ taken' = [taken EXCEPT ![r] = path] /\ path' = NoFile
          /\ Goto(r, "statTaken") /\ UNCHANGED attempt

StatTaken(r) ==
  /\ pc[r] = "statTaken"
  /\ Goto(r, IF Stale(taken[r]) THEN "rmTakenStale" ELSE "linkBack")
  /\ UNCHANGED <<path, taken, attempt>>

LinkBack(r) ==
  /\ pc[r] = "linkBack"
  /\ path' = IF path = NoFile THEN taken[r] ELSE path   \* link fails if path exists
  /\ Goto(r, "rmTakenLive")
  /\ UNCHANGED <<taken, attempt>>

RmTakenLive(r) ==
  /\ pc[r] = "rmTakenLive"
  /\ taken' = [taken EXCEPT ![r] = NoFile]
  /\ Goto(r, "done")                            \* return null
  /\ UNCHANGED <<path, attempt>>

RmTakenStale(r) ==
  /\ pc[r] = "rmTakenStale"
  /\ taken' = [taken EXCEPT ![r] = NoFile]
  /\ NextAttempt(r)
  /\ UNCHANGED path

\* The work under the lock is done; release starts.
Work(r) ==
  /\ pc[r] = "hold"
  /\ Goto(r, CASE Lock = "kernel" -> "release"
              [] Lock = "token"  -> "readOwn"
              [] OTHER           -> "rmPath")
  /\ UNCHANGED <<path, taken, attempt>>

ReadOwn(r) ==
  /\ pc[r] = "readOwn"
  /\ Goto(r, IF path = r THEN "rmPath" ELSE "done")
  /\ UNCHANGED <<path, taken, attempt>>

RmPath(r) ==
  /\ pc[r] = "rmPath"
  /\ path' = NoFile
  /\ Goto(r, "done")
  /\ UNCHANGED <<taken, attempt>>

\* Lock = "kernel": `db.close()` frees the lock.
Release(r) ==
  /\ pc[r] = "release"
  /\ path' = NoFile
  /\ Goto(r, "done")
  /\ UNCHANGED <<taken, attempt>>

\* Lock = "kernel": a holder dies; the kernel drops its lock.
Crash(r) ==
  /\ Lock = "kernel"
  /\ pc[r] = "hold"
  /\ path' = NoFile
  /\ Goto(r, "done")
  /\ UNCHANGED <<taken, attempt>>

Finished == \A r \in Runs : pc[r] = "done"

Next == \/ \E r \in Runs : \/ Create(r) \/ Stat(r) \/ RmStale(r) \/ Rename(r)
                           \/ StatTaken(r) \/ LinkBack(r) \/ RmTakenLive(r)
                           \/ RmTakenStale(r) \/ Work(r) \/ ReadOwn(r) \/ RmPath(r)
                           \/ Release(r) \/ Crash(r)
        \/ (Finished /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

(* At most one run works under the lock at a time. *)
MutualExclusion == Cardinality({r \in Runs : pc[r] = "hold"}) <= 1
=============================================================================
