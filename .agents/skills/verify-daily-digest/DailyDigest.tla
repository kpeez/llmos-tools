---------------------------- MODULE DailyDigest ----------------------------
(***************************************************************************)
(* One daily note, one digest run, and the writers who add thoughts.       *)
(*                                                                         *)
(* The digest is `processDay` in cli/src/digest.ts:                  *)
(*   DigestReadsNote   `text = existsSync(notePath) ? readText(...) : ""`  *)
(*                     before the model call (`completeSummary`)           *)
(*   DigestWritesNote  after the model call: `atomicWrite(notePath,        *)
(*                     replaceBlock(readText(notePath), block))` when the  *)
(*                     note exists, else `atomicWrite(newNoteText(...))`   *)
(* A writer is Kyle in Obsidian, or an agent through `daily_append_thought` *)
(* (cli/src/daily.ts `bodyWithThought`, written by write.ts).        *)
(*                                                                         *)
(* Assumptions:                                                            *)
(*   - Each writer save is one step: a write.ts atomic replace, or an      *)
(*     Obsidian save.                                                      *)
(*   - DigestWritesNote is one step. In the code, `readText` and the       *)
(*     rename inside `atomicWrite` are separate calls with no lock, so a   *)
(*     save in that window of microseconds is still lost. The model covers *)
(*     the window of the model call, which is seconds to minutes.          *)
(*   - One digest run at a time (the systemd timer starts one service).    *)
(*   - The digest only replaces its own block, so thoughts are a set.      *)
(*                                                                         *)
(* Write = "fresh" is the code. Write = "stale" writes the copy read       *)
(* before the model call: the code before the fix, kept as a mutant.       *)
(***************************************************************************)
CONSTANTS Thoughts, Write

VARIABLES exists,      \* the note file exists
          thoughts,    \* thoughts in the note file now
          written,     \* every thought that a writer saved
          dpc,         \* the digest: "start", "summarizing", or "done"
          snapExists,  \* `existsSync(notePath)` at DigestReadsNote
          snap         \* the thoughts in `text` at DigestReadsNote

vars == <<exists, thoughts, written, dpc, snapExists, snap>>

Init == /\ exists = FALSE /\ thoughts = {} /\ written = {}
        /\ dpc = "start" /\ snapExists = FALSE /\ snap = {}

DigestReadsNote ==
  /\ dpc = "start"
  /\ snapExists' = exists /\ snap' = thoughts
  /\ dpc' = "summarizing"
  /\ UNCHANGED <<exists, thoughts, written>>

DigestWritesNote ==
  /\ dpc = "summarizing"
  /\ exists' = TRUE
  /\ thoughts' = CASE Write = "fresh" -> thoughts
                   [] snapExists      -> snap
                   [] OTHER           -> {}
  /\ dpc' = "done"
  /\ UNCHANGED <<written, snapExists, snap>>

WriterCreatesNote(t) ==
  /\ ~exists /\ t \notin written
  /\ exists' = TRUE /\ thoughts' = {t} /\ written' = written \cup {t}
  /\ UNCHANGED <<dpc, snapExists, snap>>

WriterAddsThought(t) ==
  /\ exists /\ t \notin written
  /\ thoughts' = thoughts \cup {t} /\ written' = written \cup {t}
  /\ UNCHANGED <<exists, dpc, snapExists, snap>>

Finished == dpc = "done" /\ written = Thoughts /\ UNCHANGED vars

Next == \/ DigestReadsNote \/ DigestWritesNote
        \/ \E t \in Thoughts : WriterCreatesNote(t) \/ WriterAddsThought(t)
        \/ Finished

Spec == Init /\ [][Next]_vars

(* Every thought that a writer saved is in the note. *)
NoThoughtLost == written \subseteq thoughts
=============================================================================
