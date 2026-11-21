# Privacy check, review budget, and pull request

## Privacy check

Real animal IDs, subject names, and staff names never go in a pull request
title or body, a commit message, an issue, a knowledge note, or any file on
disk outside the vault. Knowledge notes are about published papers and
datasets and never need them. The check gates every push, the first one
included. A source may print animal names as published; never quote such a
passage. Quote another passage or a table row without them.

**Never write a token list or a name list to disk, and never type a real value
into a command.** Build each list in a pipe and feed it to `rg -f` through
process substitution (zsh or bash). Delete any scratch file you made while
checking, as a backstop; none should exist.

`CONTEXT.md` states the privacy rule, not always the shape of an identifier.
Take the identifier shapes from the project's own privacy notes or from the
owner. If you cannot, say so in your report and in the PR body; do not claim a
pass.

The owner supplies the staff and subject names in a private location inside
the vault, such as a privacy note of the project. `names()` reads that location
in a pipe. If none exists, stop and ask the owner. The PR body then states that
the name scan was not run. Do not guess names, and do not collect them from
notes or sources by hand. Still read the member notes for staff and subject
names (acknowledgements, methods) and tell the owner about any you find.

Run it from `<vault>`, the worktree's vault root. Paths are relative to it,
so the check works whether the vault is the repository root or a folder in
it.

```sh
cd <vault>
git fetch origin main
B=origin/main
P=projects/<project>                             # the owning project
SHAPES='<regex of the identifier shape(s) from the project notes>'
ids()   { rg -oNI "$SHAPES" "$P" | sort -u; }     # a pipe: nothing on disk
names() { <command that reads the owner's private name list from the vault>; }
files() { git diff --relative --name-only -z $B...HEAD -- . ':!raw/*/*'; }
added() { git diff -U0 $B...HEAD -- "$@" | rg '^\+[^+]'; }   # added lines
scan() {   # scan <list-function>: counts and paths only, never matched text
  [ "$("$1" | wc -l)" -gt 0 ] || { echo "EMPTY LIST: not a pass"; return 1; }
  echo "added lines with hits: $(added . ':!raw/*/*' | rg -F -w -f <("$1") | wc -l)"
  files | while IFS= read -r -d '' f; do
    added -- "$f" | rg -q -F -w -f <("$1") && echo "hit: $f"
  done
  echo "commit-message lines with hits: $(git log $B..HEAD --format=%B | rg -F -w -f <("$1") | wc -l)"
}
scan ids; scan names
rg -F -w -f <(ids) <pr-body-file> | wc -l       # the PR body: ids, expect 0
rg -F -w -f <(names) <pr-body-file> | wc -l     # the PR body: names, expect 0
```

- Run it after you commit and before you push. The scan excludes the capture
  folders `raw/<slug>/`, which hold frozen copies of published pages. It
  still scans the inbox drops directly in `raw/`.
- Each count prints, `0` included. Report counts and paths only. An empty list
  is never a pass.
- The scan covers added lines only. The file list is context: a member note
  can hit on text that was already in `main`, and that hit does not count.
- **Triage a numeric hit.** A shape taken from a whole project also matches
  ordinary figures. View the added lines of a hit file with the digits masked:
  `git diff -U0 $B...HEAD -- <path> | rg '^\+[^+]' | rg -F -w -f <(ids) | sed 's/[0-9]/#/g'`.
  A hit that is a count or a size in a quote from a source (an image count
  written without a comma, a pixel size, a year range, a page number, or a
  fragment of an arXiv ID or a DOI) is fine: say so in the report. If you
  cannot explain a hit that way, treat it as a real identifier. For a name hit,
  list only line numbers: `rg -F -w -n -o -f <(names) <path> | cut -d: -f1`. A
  common word that is also a name (a conference title, the surname of a paper's
  author) is a false positive that you explain; the name of an animal or of
  staff is not.
- Fix a real hit in the note, and rewrite the unpushed commit. After a push,
  assume it cannot be retracted: stop and tell the owner.

## Review-time estimate

Estimate the time one person needs to review the run:

| Item | Minutes |
| --- | --- |
| Each `drafted` or `checked` fact (read the fact and its quote) | 0.4 |
| Each flagged fact | 0.1 |
| Each open `[!conflict]` | 3 |
| Each new paper or dataset note (structure and links) | 1 |
| Each changed member note (property and link) | 0.25 |
| The hub prose | 5 |
| The captured sources (check the manifests) | 2 |

Round up to the next 5 minutes. The lint and the second check have run before
review, so these figures cover reading, not re-checking. They are a first
estimate; the owner adjusts them from the real review time.

The threshold is one rule: when the estimate is over 30 minutes, split, and
each part must be at most 30. Group the works by paper, with the datasets that
each paper introduces. The first PR holds the hub, all captured sources, all
member-note edits, and as many groups as fit. Each later PR adds the next
groups and extends the hub. The procedure is in `SKILL.md` ("Budget and split").

## Pull request

Open a draft pull request on the vault's repository from `claude/consolidate-<slug>` with
`gh pr create --draft`. Never put an animal ID, subject name, or staff name in
the title or body. The body holds the items below. When the repository's PR
tooling owns the body headings, put these items inside its sections as bold
lead-ins instead of headings.

- **Summary:** the cluster and the scope.
- **New and changed notes:** the hub, each paper note, each dataset note, each
  captured source (slug and size), each changed member note.
- **Facts by status:** the counts from `llmos claims lint <notes> --json`
  (`by_status`, `fully_checked`) as a table, plus the open conflicts, counted
  from the conflict titles: `rg -c '^> \[!conflict\] open' <notes>`.
- **Settled disagreements:** each disagreement among the member notes, and how
  the conflict rule settled it.
- **Second check:** the totals of the fact reports (`supported`,
  `unsupported`, `unclear`), the totals of the final prose reports (hub, paper and dataset notes)
  (`supported`, `unsupported`, `unbacked`, `marked`), what each non-supported
  statement led to, and the facts that remain `drafted`.
- **Forward links:** the links that stay unresolved until a later PR of the
  stack lands, when the run is split.
- **Estimated review time:** the total and its parts.
- **Checks run:** `claims lint`, `llmos audit`, `llmos check`, the member
  note checks, `just check` when the tools changed, and the privacy
  check (counts only, and what the name list was built from).

Mark the PR ready only when the owner decides. Only the owner sets `verified`.
