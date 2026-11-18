# llmOS ingest contract

This contract governs how an agent turns captured sources into compiled facts in knowledge notes. The fact and conflict formats are in [Sources and compiled facts](compiled-facts.md#compiled-facts). The `llmos-vault claims lint` verb checks them.

## Facts

- Write a fact only from the text of a captured source in `raw/`. Capture a missing source with `llmos-vault source add` first. Never write a fact from an older summary, from a member note, or from memory.
- Quote the source's own words (at least 6 words), and put the quote under the heading that holds it. Write the fact's numbers as digits, not words. Run `claims lint` on every note you change, and fix or flag each finding.
- A fact whose source is paywalled or not captured stays `flagged: source not captured`.
- The lint is necessary, not sufficient. It cannot see swapped numbers, negation, or a real quote that does not support the fact. The second pass and the human review check those.
- A new fact starts as `drafted`. It becomes `checked` when the lint and a second Claude pass that did not write the fact agree. Only the owner sets `verified`.

## Conflicts

Notes in a cluster often disagree on a number, a name, or a year. Apply these steps in order to each disagreement:

1. **Search for an earlier correction.** Search the member notes for "should read", "corrected", and the same words in the note's own phrasing. An earlier correction is evidence to read, not an answer to copy.
2. **Prefer a correction that cites the primary source.** When a note corrects a figure and cites the paper, read that paper's captured source. Write the fact from the primary source and cite it. Do not record a conflict.
3. **Record a conflict only when two primary sources disagree.** A primary source is the paper or dataset release that made the measurement. A secondary note, a survey, or a later paper that repeats a figure is not one. Differences between a preprint and its journal version, or between online and print years, are conflicts only when both versions are captured and their text disagrees.
4. **Show both quotes side by side.** Use one `[!conflict]` callout with two pairs of a quote and its source link. The two quotes differ and come from two different sources; one source twice is not a conflict. Each quote must occur in its own source section. `claims lint` checks each one like a fact quote. Do not pick a winner in the callout.
5. **Settle it in a separate fact.** When the owner decides, add a `[!fact]` that states the settled value, and change the conflict title to `resolved: <reason>`. Keep both quotes.

An open conflict is reported in the consolidation pull request so a reviewer sees it.
