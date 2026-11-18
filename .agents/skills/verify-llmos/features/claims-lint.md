# Lint claims

`claims lint` checks the `[!fact]` and `[!conflict]` callouts of a note. Each quote must occur in its source section. Each number of a fact must occur in its quote.

## Sub-features

- `lint-clean` passes a note whose callouts are right. Exit 0.
- `lint-number` finds a number that is not in the quote.
- `lint-quote` finds a quote that is not in the source.
- `lint-section` finds a quote that is in the source but not in the linked section.

## How to get to it (user POV)

- CLI: `llmos-vault claims lint <note...> [--json]`. Read-only.
- Skill `llmos:consolidate-knowledge` runs it before a pull request.

## Driving it with scripts/verify.ts

Preconditions: launch and doctor passed. The harness uses the scratch copy of `claims_vault/` as `LLMOS_ROOT`.

- **Clean note.** `llmos-vault claims lint knowledge/all-correct --json`. Exit 0. `findings` is empty.
- **Wrong number.** `... knowledge/wrong-number --json`. Exit 1. A finding has a `code`.
- **Quote absent.** `... knowledge/quote-absent --json`. Exit 1.
- **Wrong section.** `... knowledge/wrong-section --json`. Exit 1.
- Run: `bun scripts/verify.ts drive claims-lint`. Evidence goes to `claims-lint/`.

## Gotchas

- This feature uses `claims_vault`, not `vault`. The harness swaps `LLMOS_ROOT` for these commands only.
- A flagged fact is listed and does not fail. A superseded fact is skipped.
- The lint is necessary, not sufficient. It cannot see swapped numbers or negation.
- The harness checks the exit code and that a `code` exists. The exact codes are pinned by `cli/test/claims-lint.test.ts`.
