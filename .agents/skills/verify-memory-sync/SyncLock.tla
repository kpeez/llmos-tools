------------------------------ MODULE SyncLock ------------------------------
(***************************************************************************)
(* The lock file `llmos-sync.lock` in the git common dir, which            *)
(* `withLock` in cli/src/hooks/sync.ts takes around every sync run.        *)
(*                                                                         *)
(* Each action is one file-system call in the code:                        *)
(*   Create      `create`: `openSync(path, "wx")` and `writeSync(token)`   *)
(*   Stat        `acquire`: `statSafe(path)`, fresh lock -> return null    *)
(*   Rename      `acquire`: `renameSync(path, taken)`                      *)
(*   StatTaken   `acquire`: `statSafe(taken)`                              *)
(*   LinkBack    `acquire`: `linkSync(taken, path)` (live lock taken)      *)
(*   RmTaken     `acquire`: `rmSync(taken)`                                *)
(*   ReadOwn     `release`: `readFileSync(path) === token`                 *)
(*   RmPath      `release`: `rmSync(path)`                                 *)
(*                                                                         *)
(* Lock = "token" is the code. Lock = "rm" is the lock before the fix that *)
(* introduced tokens (kept as a mutant): a stale lock is removed with      *)
(* `rmSync(path)` without a check that it is still the stale file, and     *)
(* release removes the lock file whoever owns it.                          *)
(*                                                                         *)
(* Assumptions:                                                            *)
(*   - A lock file is stale only when its run is gone (killed by the hook  *)
(*     timeout). Hooks run at most 30 s, the stale age is 60 s, so a live  *)
(*     run's lock is always fresh. The killed run's lock is "orphan".      *)
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

Init == /\ path \in {NoFile, "orphan"}
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
     ELSE UNCHANGED path /\ Goto(r, "stat")
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
  /\ Goto(r, IF Lock = "token" THEN "readOwn" ELSE "rmPath")
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

Finished == \A r \in Runs : pc[r] = "done"

Next == \/ \E r \in Runs : \/ Create(r) \/ Stat(r) \/ RmStale(r) \/ Rename(r)
                           \/ StatTaken(r) \/ LinkBack(r) \/ RmTakenLive(r)
                           \/ RmTakenStale(r) \/ Work(r) \/ ReadOwn(r) \/ RmPath(r)
        \/ (Finished /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

(* At most one run works under the lock at a time. *)
MutualExclusion == Cardinality({r \in Runs : pc[r] = "hold"}) <= 1
=============================================================================
