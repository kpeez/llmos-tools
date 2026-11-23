---------------------------- MODULE LlmosService ----------------------------
(***************************************************************************)
(* How `llmos service serve` processes start and stop on one host.         *)
(*                                                                         *)
(* Each process in Procs is a starter (serveService in cli/src/service.ts):*)
(* it takes the start lock, asks whether a service listens on              *)
(* service.sock (socketLive), removes a socket file that nobody listens    *)
(* on, binds, and releases the lock. A starter that binds becomes the      *)
(* service and later stops: idle stop or SIGTERM, both `close()`. Any      *)
(* process can crash at any step, up to MaxCrashes times.                  *)
(*                                                                         *)
(* Lock = "kernel" is the code: an exclusive SQLite transaction on         *)
(*   service.lock.db. The kernel grants it to one process at a time and    *)
(*   drops it when the holder exits or crashes; nobody deletes a file.     *)
(* Lock = "file" is the code before the fix: `writeFileSync(lock, pid,     *)
(*   {flag: "wx"})`, which is an open and then a write, a rival that       *)
(*   removes a lock whose content is empty or names a dead pid, and a      *)
(*   release that removes whatever lock file is there.                     *)
(* CloseRemoves = TRUE is the code before the fix: `close()` runs          *)
(*   `rmSync(paths.socket)` after `server.close()`. server.close() itself  *)
(*   unlinks the socket path by name (Bun and libuv both do).              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Procs, Lock, CloseRemoves, MaxCrashes

ASSUME Lock \in {"file", "kernel"}
ASSUME CloseRemoves \in BOOLEAN

NoProc == "none"
NoFile == [creator |-> NoProc, content |-> NoProc]

VARIABLES
  pc,           \* each process's next step
  lockFile,     \* Lock = "file": the file service.lock, or NoFile
  kernelHolder, \* Lock = "kernel": the process that holds the lock, or NoProc
  socket,       \* the process whose socket file is at service.sock, or NoProc
  listening,    \* the processes that still listen on the socket they bound
  crashes,
  brokeLock,    \* a process removed a lock file whose creator still holds it
  brokeSocket   \* a process removed the socket file of another listening service

vars == <<pc, lockFile, kernelHolder, socket, listening, crashes, brokeLock, brokeSocket>>

(* The steps between taking the lock and releasing it. *)
Holding == {"write", "probe", "rmsock", "bind", "relServe", "relExit", "relFail"}

Init ==
  /\ pc = [p \in Procs |-> "start"]
  /\ lockFile = NoFile
  /\ kernelHolder = NoProc
  /\ socket = NoProc
  /\ listening = {}
  /\ crashes = 0
  /\ brokeLock = FALSE
  /\ brokeSocket = FALSE

Goto(p, step) == pc' = [pc EXCEPT ![p] = step]

(* A lock file whose creator is still between its open and its release. *)
LiveLock(f) == f /= NoFile /\ pc[f.creator] \in Holding

(* The socket file at the path belongs to a service that still listens. *)
LiveSocket == socket /= NoProc /\ socket \in listening

(* ---- Lock = "file": the code before the fix ---- *)

(* writeFileSync(paths.lock, pid, {flag: "wx"}): the open with O_EXCL. *)
FileCreate(p) ==
  /\ Lock = "file" /\ pc[p] = "start"
  /\ IF lockFile = NoFile
       THEN /\ lockFile' = [creator |-> p, content |-> ""]
            /\ Goto(p, "write")
       ELSE /\ Goto(p, "read")
            /\ UNCHANGED lockFile
  /\ UNCHANGED <<kernelHolder, socket, listening, crashes, brokeLock, brokeSocket>>

(* writeFileSync's write of the pid, through the open file. *)
FileWrite(p) ==
  /\ pc[p] = "write"
  /\ lockFile' = IF lockFile.creator = p THEN [lockFile EXCEPT !.content = p] ELSE lockFile
  /\ Goto(p, "probe")
  /\ UNCHANGED <<kernelHolder, socket, listening, crashes, brokeLock, brokeSocket>>

(* EEXIST: read the pid (and the age), then processAlive(holder). An empty  *)
(* file parses to NaN, which counts as a dead holder.                       *)
FileRead(p) ==
  /\ pc[p] = "read"
  /\ IF lockFile = NoFile
       THEN Goto(p, "start")
       ELSE IF lockFile.content = "" \/ pc[lockFile.content] = "dead"
              THEN Goto(p, "rmlock")
              ELSE Goto(p, "start")
  /\ UNCHANGED <<lockFile, kernelHolder, socket, listening, crashes, brokeLock, brokeSocket>>

(* rmSync(paths.lock): removes whatever lock file is there now. *)
FileBreak(p) ==
  /\ pc[p] = "rmlock"
  /\ brokeLock' = (brokeLock \/ LiveLock(lockFile))
  /\ lockFile' = NoFile
  /\ Goto(p, "start")
  /\ UNCHANGED <<kernelHolder, socket, listening, crashes, brokeSocket>>

(* ---- Lock = "kernel": the code ---- *)

(* BEGIN EXCLUSIVE on service.lock.db; a busy lock means wait and try again. *)
KernelAcquire(p) ==
  /\ Lock = "kernel" /\ pc[p] = "start"
  /\ kernelHolder = NoProc
  /\ kernelHolder' = p
  /\ Goto(p, "probe")
  /\ UNCHANGED <<lockFile, socket, listening, crashes, brokeLock, brokeSocket>>

(* ---- The work under the lock, the same in both designs ---- *)

(* socketLive(paths.socket): a connect succeeds only while the service listens. *)
Probe(p) ==
  /\ pc[p] = "probe"
  /\ Goto(p, IF LiveSocket THEN "relExit" ELSE "rmsock")
  /\ UNCHANGED <<lockFile, kernelHolder, socket, listening, crashes, brokeLock, brokeSocket>>

(* rmSync(paths.socket) before the bind. *)
RemoveSocket(p) ==
  /\ pc[p] = "rmsock"
  /\ brokeSocket' = (brokeSocket \/ LiveSocket)
  /\ socket' = NoProc
  /\ Goto(p, "bind")
  /\ UNCHANGED <<lockFile, kernelHolder, listening, crashes, brokeLock>>

(* server.listen(paths.socket): EADDRINUSE when any file is at the path. *)
Bind(p) ==
  /\ pc[p] = "bind"
  /\ IF socket = NoProc
       THEN /\ socket' = p
            /\ listening' = listening \cup {p}
            /\ Goto(p, "relServe")
       ELSE /\ Goto(p, "relFail")
            /\ UNCHANGED <<socket, listening>>
  /\ UNCHANGED <<lockFile, kernelHolder, crashes, brokeLock, brokeSocket>>

(* The end of withStartLock. relServe goes on to serve; relExit is          *)
(* ServiceInUse (exit 0); relFail is the bind error (the process exits).     *)
Release(p) ==
  /\ pc[p] \in {"relServe", "relExit", "relFail"}
  /\ IF Lock = "file"
       THEN \* finally rmSync(paths.lock), whoever created it
            /\ brokeLock' = (brokeLock \/ (lockFile.creator /= p /\ LiveLock(lockFile)))
            /\ lockFile' = NoFile
            /\ UNCHANGED kernelHolder
       ELSE /\ kernelHolder' = NoProc
            /\ UNCHANGED <<lockFile, brokeLock>>
  /\ Goto(p, IF pc[p] = "relServe" THEN "serving" ELSE "done")
  /\ UNCHANGED <<socket, listening, crashes, brokeSocket>>

(* close(): server.close() unlinks the socket path by name and stops listening. *)
Close(p) ==
  /\ pc[p] = "serving"
  /\ brokeSocket' = (brokeSocket \/ (socket /= p /\ LiveSocket))
  /\ socket' = NoProc
  /\ listening' = listening \ {p}
  /\ Goto(p, IF CloseRemoves THEN "closeRm" ELSE "done")
  /\ UNCHANGED <<lockFile, kernelHolder, crashes, brokeLock>>

(* The code before the fix: rmSync(paths.socket) after server.close(). *)
CloseRemove(p) ==
  /\ pc[p] = "closeRm"
  /\ brokeSocket' = (brokeSocket \/ LiveSocket)
  /\ socket' = NoProc
  /\ Goto(p, "done")
  /\ UNCHANGED <<lockFile, kernelHolder, listening, crashes, brokeLock>>

(* A crash or SIGKILL: files stay, the listen stops, the kernel lock goes. *)
Crash(p) ==
  /\ crashes < MaxCrashes
  /\ pc[p] \notin {"done", "dead"}
  /\ crashes' = crashes + 1
  /\ listening' = listening \ {p}
  /\ kernelHolder' = IF kernelHolder = p THEN NoProc ELSE kernelHolder
  /\ Goto(p, "dead")
  /\ UNCHANGED <<lockFile, socket, brokeLock, brokeSocket>>

(* Every process has exited: a final state, not a deadlock. *)
Terminated == \A p \in Procs : pc[p] \in {"done", "dead"}

Next ==
  \/ Terminated /\ UNCHANGED vars
  \/ \E p \in Procs :
       \/ FileCreate(p) \/ FileWrite(p) \/ FileRead(p) \/ FileBreak(p)
       \/ KernelAcquire(p)
       \/ Probe(p) \/ RemoveSocket(p) \/ Bind(p) \/ Release(p)
       \/ Close(p) \/ CloseRemove(p) \/ Crash(p)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

TypeOK ==
  /\ pc \in [Procs -> {"start", "write", "read", "rmlock", "probe", "rmsock", "bind",
                       "relServe", "relExit", "relFail", "serving", "closeRm", "done", "dead"}]
  /\ socket \in Procs \cup {NoProc}
  /\ listening \subseteq Procs
  /\ kernelHolder \in Procs \cup {NoProc}

(* At most one starter is between taking the start lock and releasing it. *)
MutualExclusion == \A p, q \in Procs : (p /= q /\ pc[p] \in Holding) => pc[q] \notin Holding

(* Every service that listens is the one bound at service.sock: at most one *)
(* service is live, and no service holds its models where no client reaches. *)
NoOrphan == \A p \in listening : socket = p

(* Nobody removes a lock file that its creator still holds. *)
NoLiveLockBroken == ~brokeLock

(* Nobody removes the socket file of another service that still listens. *)
NoLiveSocketDeleted == ~brokeSocket
=============================================================================
