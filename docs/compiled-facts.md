# Sources and compiled facts

This is the specification of two formats that the llmOS CLI writes and checks: the folder that `llmos source add` captures, and the `[!fact]` and `[!conflict]` callouts that `llmos claims lint` reads. The code enforces these rules, so they ship with the code. A vault's own content conventions, such as its folders, categories, and topics, live in the vault's `schema.md`. [The ingest contract](ingest-contract.md) says how an agent writes facts from captured sources.

The examples link sources with Obsidian wikilinks, as a note in the vault does.

## Sources

`llmos source add` captures an arXiv paper, a web page, or a PDF into `raw/<slug>/`. A web page is converted by defuddle. When defuddle keeps less than a tenth of the visible words of a page of 500 words or more, it runs again on the page's article container, and the capture records that selector in `converter`; when no container holds the text, the capture keeps defuddle's text and prints a warning. A PDF (a file, a URL that serves one, or an arXiv paper without an HTML version) is converted by MinerU on this machine. An arXiv slug is `arxiv-<id>v<N>`; a web slug is the host and path in lowercase words plus eight hex digits of the source ID's hash; a PDF file's slug takes its words from `--origin`, else from the file name. Large files go to Git LFS (the vault's `.gitattributes`). Nobody edits a source folder after capture; a newer version is a new folder.

- `raw.html` or `raw.pdf`: the page or PDF bytes as fetched or given.
- `assets/`: for a PDF, the images MinerU cut out that the text or a figure shows. For a page, the images of its captioned figures, as fetched. Only responses of type `image/*` are kept; one that is not, or that fails, is skipped and named in the command output. Names are unique ignoring case. A figure is a top-level `<figure>` (no `<figure>` above it) with a `<figcaption>` that is its own direct child; a panel's caption is not its caption. On arXiv's LaTeXML pages it must also have class `ltx_figure` and not `ltx_lstlisting`, so tables, algorithms, and listings do not count. In a PDF, a figure is an image or chart block whose caption starts with a figure label (`Fig. 3`, `Figure S2`); its panels are the blocks before it on its page with no caption or only a panel letter, back to the previous figure there.
- `source.md`: the defuddle or MinerU text, with links to downloaded or cut-out figure images rewritten to `assets/<name>`, ending in a `## Figures` section with each caption and its images. Its frontmatter is the manifest:
  - `categories`, `created`: as for any note.
  - `origin`: the URL fetched (for an arXiv PDF, `https://arxiv.org/pdf/<id>v<N>`). For a PDF file, the `--origin` URL, else `file:<name>`.
  - `source_id`: `arxiv:<id>v<N>` (the version fetched), `web:<url>`, or, for a PDF file, `sha256:<hash of the PDF bytes>`.
  - `retrieved`: the capture date.
  - `licence`: the licence link as the page states it (for arXiv, the link on the abstract page), or `not stated`. For a PDF file or web PDF, the `--licence` text as the PDF states it, else `not stated`.
  - `converter`: the text converter and what reproduces the text, such as `defuddle@0.19.4`, `defuddle@0.19.4 contentSelector=.article.fulltext-view`, or `mineru@4.0.12 --tier advanced --disable-image-analysis`.
  - `sha256_raw`: SHA-256 of `raw.html` or `raw.pdf`.
  - `sha256_text`: SHA-256 of the UTF-8 bytes of the `source.md` body, which is the text after the closing `---` line and its one blank line, up to and including the final newline. Parse the file with `frontmatter.ts` `parse` and hash `body`.
  - `figures`: the count of captioned figures.

## Compiled facts

A knowledge note states each checkable fact as a `[!fact]` callout that quotes its source. `llmos claims lint <notes>` reads these callouts and checks them against the captured source text. The lint is read-only.

```markdown
> [!fact] checked
> The rhesus macaque dataset holds 1,399 images of 59 individuals.
> > "The filtered dataset had 59 identities with a total of 1399 images"
> — [[raw/arxiv-1811.00743v2/source#Rhesus Macaques Dataset|Shukla 2018, Dataset]]

^fact-rhesus-dataset-size
```

- **Title:** the status, as listed below. The callout type is `fact`. Start the callout with `> [!fact] <status>` at the start of a line: not indented, not in a list, not nested in another quote, and without `+` or `-` fold marks.
- **Fact:** the first body line or lines. State one claim in your own words. Write numbers as digits, never as words. Keep author-year citations out of the fact; the source line carries them. Do not embed (`![[...]]`) in a fact.
- **Quote:** one nested blockquote that holds the source's words in double quotation marks. A quote may wrap over several `> >` lines. It needs at least 6 words (see the quote rules below).
- **Source line:** the last line. It is exactly `— ` (an em dash and a space) and one wikilink to a heading of a captured source, with nothing after the link. The link target is the source folder path ending in `source` (as in the example), then `#` and the heading, then optionally `|` and a label. Every source note is named `source`, so the link needs its folder. The lint does not read the label, so no claim belongs in it.
- **Block ID:** `^fact-<slug>` (lowercase letters, digits, and hyphens) on its own line, with one blank line between the callout and the ID. Obsidian's help says: "For *structured blocks* (lists, quotations, callouts, tables), the block identifier should be on a separate line, with a blank line before and after". An ID directly under the callout, with no blank line, is a `malformed` finding: Markdown would read it as part of the callout's last line. The ID is unique in the note.

### Fact statuses

| Status | Meaning | Lint |
| --- | --- | --- |
| `drafted` | An agent wrote the fact. | Checked. |
| `checked` | The lint and a second Claude pass that did not write the fact agree. | Checked. |
| `verified` | The owner checked the fact. Only the owner sets it. | Checked. |
| `superseded` | A later fact or source replaced it. Keep it for history. | Skipped. Its block ID still counts for duplicates. |
| `flagged: <reason>` | The fact cannot be checked yet. It stays visible with its reason. | Listed with its reason. Its content is not checked, so it does not fail. |

A flagged fact needs no quote and no block ID. Its structure still counts: it has fact text and a source line, and a malformed one fails. A block ID that it does have must follow the block ID rules. A fact whose source is paywalled or was not captured is flagged with the reason `source not captured`, and its last line is a plain citation:

```markdown
> [!fact] flagged: source not captured
> TMacaque-FaceNet reports 96.3% top-1.
> — Gao 2026, doi:10.3390/ani16071107
```

A superseded fact keeps its quote and link, which the lint does not read:

```markdown
> [!fact] superseded
> The rhesus macaque dataset holds 1,300 images.
> > "The filtered dataset had 59 identities with a total of 1300 images"
> — [[raw/arxiv-1811.00743v2/source#Rhesus Macaques Dataset|Shukla 2018, Dataset]]

^fact-rhesus-dataset-old-size
```

A `drafted`, `checked`, or `verified` fact is the first example with that word as the title.

### What the lint checks

Findings fail the run (exit 1). The report counts facts by status, and separately counts the facts that are *fully checked*: drafted, checked, or verified facts that passed every check. A flagged or superseded fact is never fully checked. The finding codes are `malformed`, `unknown-status`, `missing-block-id`, `duplicate-block-id`, `bad-source-link`, `missing-heading`, `heading-not-found`, `ambiguous-heading`, `source-integrity`, `quote-too-short`, `quote-not-in-section`, `quote-not-in-source`, `number-not-in-quote`, `number-word`, and `identifier-mismatch`.

- **Structure:** a `drafted`, `checked`, or `verified` fact has fact text, one quote in quotation marks, and a final source line, in that order, plus a block ID. A line that starts like `[!fact…]` or `[!conflict…]` (after `>`, spaces, or list markers) but does not parse is a `malformed` finding, so an indented, nested, listed, or misspelled callout cannot hide. A callout in a code fence is an example and is not read. A fence opener with a backtick in its info string is not a fence, and a closing fence has no text after it. A fence that is never closed hides the rest of the note; the report then has a warning ("fence opened at line N is never closed; M lines not linted"), which does not fail the lint.
- **Source:** the link must resolve to `raw/<slug>/source` and name a heading that occurs once in that source. Heading names match without case and without the characters `# | ^ : [ ]`, as in an Obsidian link. The lint recomputes `sha256_text` from the source body, as the Sources section describes. A source with no `source_id`, no `sha256_text`, or a hash that does not match is a `source-integrity` finding on every fact that cites it. It cannot check `sha256_raw`, because `raw.html` is in Git LFS.
- **Section:** the quote must occur in the linked heading's section: the text from the heading to the next heading of the same or a higher level. Subsections belong to their parent, as in an Obsidian embed of a heading. The lint names the other place when the quote occurs elsewhere in the source.
- **Normalization:** the quote and the section go through the same steps. Superscript digits become `^` and digits (`10⁴` is `10^4`), before NFKC (ligatures such as `ﬁ`, no-break spaces); soft hyphens and zero-width characters are removed; curly quotes are made straight; the Unicode hyphens U+2010 and U+2011 become `-`; `+/-` and the LaTeX `\pm`, `\times`, `\le`, `\leq`, `\ge`, `\geq`, `\approx` become `±`, `×`, `≤`, `≥`, `≈` (with or without `$...$`), and `^{-3}` becomes `^-3`; Markdown is reduced to its rendered text (a link keeps its label; footnote references go; `<sup>4</sup>` becomes `^4` only when it directly follows a digit or `)` and holds no link (`(a+b)<sup>2</sup>` is `(a+b)^2`), and any other superscript is a footnote or citation marker and is dropped with its digits (`images<sup><a>37</a></sup>` is `images`; so is `x<sup>2</sup>`, a trade-off: superscripts after letters are treated as markers, so quote such a power without its exponent or use an elision); `<sub>2</sub>` becomes `_2`; inline tags such as `<b>` and `<a>` go; table, block, and MathML tags (`<td>`, `<th>`, `<tr>`, `<br>`, `<p>`, `<li>`, `<math>`, and the like) become a space, so `54.69</td><td>65.92` does not merge into one number; a MathML `<annotation>` is dropped, because it repeats the formula; other `<...>` text stays, as in `n<m` or an autolink; backslash escapes such as `\%` resolve; `*`, backticks, and `$` math delimiters go, but not the `$` of `US$5`); a removed mark between a digit and a digit or letter, or between a letter and a digit, leaves a space, so `3*5` is not `35` and `n*5000` is not `n5000`; any Unicode digit (`٥`, `५`) becomes its ASCII digit; white space, including line breaks, becomes one space; `95 %` becomes `95%`. Case and all other characters must match. A quote must start and end at word and number edges: `93 monkeys` does not match `1093 monkeys`, and `3` does not match `3.5`.
- **Elisions:** `…`, `...`, and `[...]` in a quote skip source text. The parts between elisions must occur in order, and each follows the same edge rule.
- **Quote length:** the quote has at least 6 words in all, and each part between elisions has at least 3 words and at least one word that is not a stop word (`the`, `of`, `and`, `to`, `be`, and the like). A word is a token with a letter or a digit. A quote such as `"the"`, `"."`, or `"… 59 …"` is a `quote-too-short` finding, because it would prove anything. A part of 3 words can still come from an unrelated sentence, and the lint cannot tell. For a table, quote the whole row, including the row label: one cell has no context and is not evidence, and the 6-word floor rejects it.
- **Numbers:** every number in the fact text must occur in the quote.
  - A number is digits with an optional decimal part, thousands groups of exactly three digits (`6,280` and `6280` are the same number), and an optional exponent glued to it: `e-9` or `E5` (`59e-9`), or `^4` or `^-3` (`10^4`, which is also `10⁴` and `10^{4}`). Values compare as written, so `3.50` is not `3.5` and `59e-9` is not `59`. In `5×10^4`, `5` and `10^4` are two numbers.
  - A `%` or the word `percent` right after the number in the fact must be followed by `%` or `percent` after the same number in the quote, and so must a `±` before it. The quote may carry more than the fact does.
  - A minus sign (`-`, `−`, or `–`) that directly precedes the digits, with no letter or digit before the sign, is part of the number (`-3.2`, `(−3)`, `x = −3`). A negative number matches only a negative number. A hyphen between a letter or digit and the digits is not a sign, so `top-1`, `5-fold`, and the `20` of the range `10-20` are positive; the range needs both 10 and 20 in the quote. A `+` is not part of a number.
  - Digits on both sides of an `x`, `X`, or `×` are two numbers: `224x300` needs both 224 and 300 in the quote (`$224\times 224$` has 224 twice).
  - The lint checks the numbers the reader sees. A wikilink with a label counts as its label. A wikilink without a label counts as its target and heading as written, so `[[note#5000 more images]]` has the number 5000. An autolink `<https://...>` counts as its URL text. A Markdown link `[label](url)` counts as its label.
  - A number with a unit or suffix (`5-fold`, `34mm`, `3D`) is checked, and so is a currency amount (`US$9999` and `USD9999` are the number 9999; the codes are USD, EUR, GBP, JPY, and CNY).
  - A number word (`zero` to `twenty`, the tens, `hundred`, `thousand`, `million`, `billion`, `dozen`, `half`, `twice`, `double`, `triple`, `thousands`, `hundreds`, `dozens`, `doubled`, `tripled`, `halved`, `quadrupled`, `couple`, `percent`) in the fact is a `number-word` finding, because it cannot be checked. Write the digits. The word `percent` right after a digit is the `%` sign and is allowed. Ordinals (`first`), `several`, and `single` are not on the list. A word that the quote also uses (`five` in "five stratified splits") is the source's own word and is allowed. The list also catches common words: `one`, `double-blind`, and `one-hot` are findings. Rephrase: "a single run" for "one run", or "blinded" for "double-blind". When the source itself says "one-hot", quote that phrase: the quote then uses the same word, and the finding goes away.
- **Numbers the lint does not check:** digits that belong to an identifier, meaning a letter or `_` directly before them, or a letter and one `-` before them (`top-1`, `ResNet-50`, `DINOv2`, `v2`, `L2`, `COVID-19`), or a dotted number before them (the `3` in `1.2.3`). One exception: when the quote has the same letters (any case, with or without a hyphen) and other digits, the fact's identifier must match, or the finding is `identifier-mismatch`. `ResNet-101` in the fact against `ResNet-18` or `ResNet18` in the quote fails, and so do `ResNet101` against `ResNet-18` and `Pool4` against `Pool5`. When the quote has no identifier with the same letters, the digits go unchecked (see "An identifier the quote does not name" below). Citation years are not checked, but only in these shapes, with an optional letter after the year (`2018a`): `(Name, 2018)`, `(Name et al., 2018)`, `(Name and Name, 2018)`, several of them separated by `;`, and `Name et al. (2018)`. A bare year (`in 2018`), `(since 2018)`, `(Rhesus, 2000 images)`, `(N = 1999)`, and `Dataset (2000)` are checked.
- **Block IDs:** two `^fact-` or `^conflict-` IDs that are the same in one note are a finding, including on a superseded fact.

### What the lint cannot check

The lint is necessary, not sufficient. A fact can pass and still be wrong in ways the lint does not see:

- **Swapped numbers:** "1399 identities and 59 images" passes when the quote has both numbers in the other order.
- **Negation and polarity:** "does not have 59" and "has fewer than 59" pass when the quote says "has 59".
- **A real but irrelevant quote:** the quote is in the source and has the fact's numbers, but it does not say what the fact says. A quote part of 3 words, or a quote that joins parts of unrelated sentences with elisions, can pass the length rule and still prove nothing.
- **An identifier the quote does not name:** the lint skips the digits of an identifier when the quote has no identifier with the same letters. A wrong `Dataset-9999` passes against a quote that never names it. The stricter rule would require the digits as a plain number in the quote. In a consolidation pilot, 9 of 138 lint-checked facts had an identifier whose letters the quote does not name, and none was a wrong value, so the stricter rule could only have added false failures. The second Claude pass must check such identifiers against the quote.
- **Text it does not read:** the link label, the citation year of a fact in the shapes above, and the words of the fact other than numbers.

The second Claude pass that moves a fact to `checked`, and the owner's review that moves it to `verified`, have to catch these. A fully checked fact is evidence for them to confirm, not a verdict.

### Conflicts

When two primary sources disagree, record both quotes in one `[!conflict]` callout (see [the ingest contract](ingest-contract.md) for when to record one):

```markdown
> [!conflict] open
> The papers disagree on the number of C-Tai images: 5057 or 5,078.
> > "C-Zoo and C-Tai dataset consists of 24 and 66 individuals with 2109 and 5057 images respectively"
> — [[raw/arxiv-1811.00743v2/source#Chimpanzee Dataset|Shukla 2018, Chimpanzee Dataset]]
> > "The C-Zoo dataset is comprised of 2,109 face images of 24 chimpanzees and 5,078 face images of 78 individuals are from the C-Tai dataset"
> — [[raw/arxiv-1804.08790v1/source#2.3 ChimpanzeeFace Dataset|Deb 2018, ChimpanzeeFace Dataset]]

^conflict-c-tai-images
```

The title is `open` or `resolved: <reason>`. The body is the statement, then two pairs of a quote and a source line. The two quotes must differ and must come from two different sources. The lint checks each quote against its own source section, as for a fact, and each number of the statement must occur in one of the two quotes. A resolved conflict keeps both quotes; the fact that settles it is a separate `[!fact]`. The second source of the example is the one that `llmos source add 1804.08790` captures.
