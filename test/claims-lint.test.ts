import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type ClaimsReport, normalizeText } from "../src/claims-lint.ts";
import { parse } from "../src/frontmatter.ts";
import { VaultModel } from "../src/vault.ts";
import { cli, makeVault } from "./helpers.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "claims_vault");

async function lintJson(root: string, ...paths: string[]) {
  const result = await cli(root, ["claims", "lint", ...paths, "--json"]);
  return { exitCode: result.exitCode, report: JSON.parse(result.stdout) as ClaimsReport };
}

describe("the fixture vault", () => {
  test("a note whose facts are all correct passes, counts its facts, and reports its flagged fact", async () => {
    const { exitCode, report } = await lintJson(FIXTURE, "knowledge/all-correct.md");
    expect(report.findings).toEqual([]);
    expect(exitCode).toBe(0);
    // One of each status; the superseded fact holds a wrong number and is skipped.
    expect(report.by_status).toEqual({
      drafted: 1,
      checked: 3,
      verified: 1,
      superseded: 1,
      flagged: 1,
    });
    // Flagged and superseded facts are counted by status and never fully checked.
    expect(report.fully_checked).toBe(5);
    expect(report.conflicts).toBe(1);
    expect(report.flagged.map((f) => f.reason)).toEqual(["source not captured"]);
  });

  test.each([
    ["wrong-number", "number-not-in-quote", 8],
    ["quote-absent", "quote-not-in-source", 8],
    ["wrong-section", "quote-not-in-section", 10],
  ])("%s fails with %s at the callout's line", async (note, code, line) => {
    const { exitCode, report } = await lintJson(FIXTURE, `knowledge/${note}.md`);
    expect(report.findings.map((f) => `${f.code}:${f.line}`)).toEqual([`${code}:${line}`]);
    expect(report.fully_checked).toBe(0);
    expect(exitCode).toBe(1);
  });

  test("the fully correct note has no broken links and no unlinked references", async () => {
    const check = await cli(FIXTURE, ["check", "knowledge/all-correct.md"]);
    expect(check.exitCode).toBe(0);
    expect(JSON.parse(check.stdout).findings).toEqual([]);
    const unresolved = VaultModel.load(FIXTURE)
      .linkFindings()
      .unresolved_links.filter((link) => link.referrer === "all-correct");
    expect(unresolved).toEqual([]);
  });

  test("a call without a path is a usage error, and the text summary names each finding", async () => {
    expect((await cli(FIXTURE, ["claims", "lint"])).exitCode).toBe(2);
    const text = await cli(FIXTURE, ["claims", "lint", "knowledge/wrong-number.md"]);
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toContain("knowledge/wrong-number.md:8 number-not-in-quote");
    expect(text.stdout).toContain("0 fully checked");
  });

  test("a path given twice is linted once", async () => {
    const { report } = await lintJson(
      FIXTURE,
      "knowledge/wrong-number.md",
      "knowledge/wrong-number.md",
    );
    expect(report.notes).toEqual(["knowledge/wrong-number.md"]);
    expect([report.facts, report.findings.length]).toEqual([1, 1]);
  });
});

// One source whose text holds each form the lint must see through.
const SHY = String.fromCharCode(0xad);
const SOURCE_BODY = `# S

## Data

The set has 1093 monkeys and 3.5 layers in the larger study. The top-1 score is 95 % for ResNet-50 and DINOv2 (v2) on the closed-set protocol.
A ﬁne “quoted” co${SHY}operation was seen in every single trial run. Rates were ± 2 on 6,280 images across all the folds.
The change was -3.2 points, over 10-20 folds in the larger study. A gain of 3.2 points was also seen in the smaller one.
Many
  lines   wrap across the page in this long sentence. Also 99\\% of $1.3$ hours were recorded in the main run. Alpha beta gamma delta epsilon zeta.
The cost was US$9999 for the whole run of the study. The rate was 1e-3 and the decay was 59e-9 with 10⁴ steps in the main run.
To be or not to be, that is the question for us. Values 1093 3.5 6,280 2 3 4 appeared in the table.
We resize all cropped faces to $224\\times 224$ in the main run of the study. AlexNet Pool5 features with PCA were the best in the macaque runs.
The ResNet-18 backbone reached 97.97 on the closed-set protocol in this run. The ResNet18 backbone also reached 96.52 on the closed-set protocol in this run.
The assay dose was 10<sup>4</sup> cells per well in the experiment today. The sample size was n*5000 animals in the long running test.
The fee was USD9999 in total for the whole run of the study. We counted 1399 images<sup><a href="#fn:37">37</a></sup> of macaques in the main run of the study. We report the mean accuracy over five stratified splits of the data in the main run. We kept sixteen stratified splits of the data in the second run.

### Deeper

Deep text here for the second section of this long page.

## Other

Other text here for the third section of this long page.

## Table

<table><tr><th>ResNet-18 closed set</th><td>54.69</td><td>65.92</td><td>82.48</td></tr><tr><th>SphereFace on lemurs</th><td>90.82 <math><semantics><mo>±</mo> <annotation>\\pm</annotation></semantics></math> 1.80</td><td>N/A</td></tr></table>

## Twice

First section text for the repeated heading here today.

## Twice

Second section text for the repeated heading here today.
`;

/** A source note whose manifest matches its body, as `source add` writes it. */
function sourceNote(body: string, manifest: Record<string, string | null> = {}): string {
  const fields: Record<string, string | null> = {
    sha256_text: createHash("sha256").update(body).digest("hex"),
    source_id: "web:https://example.org/s",
    ...manifest,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`);
  const text = `---\ncategories:\n  - "[[Sources]]"\n${lines.join("\n")}\n---\n\n${body}`;
  expect(parse(text).body).toBe(body);
  return text;
}

const SOURCE_TWO_BODY = `# T

## Data

Our dataset reports 6,380 images in total over all the folds.
`;

const LINK = "[[sources/s/source#Data|S]]";
const Q_SET = '"The set has 1093 monkeys and 3.5 layers in the larger study"';
const Q_SCORE =
  '"The top-1 score is 95 % for ResNet-50 and DINOv2 (v2) on the closed-set protocol"';
const Q_RATES = '"Rates were ± 2 on 6,280 images across all the folds"';
const Q_CHANGE = '"The change was -3.2 points, over 10-20 folds in the larger study"';
const Q_GAIN = '"A gain of 3.2 points was also seen in the smaller one"';
const Q_COST = '"The cost was US$9999 for the whole run of the study"';
const Q_EXP = '"The rate was 1e-3 and the decay was 59e-9 with 10⁴ steps in the main run"';
const Q_RESIZE = '"We resize all cropped faces to $224\\times 224$ in the main run of the study"';
const Q_POOL = '"AlexNet Pool5 features with PCA were the best in the macaque runs"';
const Q_R18 = '"The ResNet-18 backbone reached 97.97 on the closed-set protocol in this run"';
const Q_R18B = '"The ResNet18 backbone also reached 96.52 on the closed-set protocol in this run"';
const Q_SUP = '"The assay dose was 10<sup>4</sup> cells per well in the experiment today"';
const Q_STAR = '"The sample size was n*5000 animals in the long running test"';
const Q_FEE = '"The fee was USD9999 in total for the whole run of the study"';
const Q_SIXTEEN = '"We kept sixteen stratified splits of the data in the second run"';
const Q_MARKED = '"We counted 1399 images of macaques in the main run of the study"';
const Q_FIVE =
  '"We report the mean accuracy over five stratified splits of the data in the main run"';
const TABLE = "[[sources/s/source#Table|S]]";
const Q_ROW = '"ResNet-18 closed set 54.69 65.92 82.48"';
const Q_MATH = '"SphereFace on lemurs 90.82 ± 1.80 N/A"';
const Q_OTHER = '"Other text here for the third section of this long page"';

function callout(
  status: string,
  text: string,
  quote: string | null,
  link = LINK,
  id: string | null = "^fact-x",
): string {
  return [
    `> [!fact] ${status}`,
    `> ${text}`,
    ...(quote === null ? [] : [`> > ${quote}`]),
    `> — ${link}`,
    ...(id === null ? [] : ["", id]),
  ].join("\n");
}

/** The lint's report for a note made of `blocks`, linted against `SOURCE_BODY`. */
async function lintNote(
  blocks: string[],
  files: Record<string, string> = {},
): Promise<ClaimsReport> {
  const root = makeVault({
    "sources/s/source.md": sourceNote(SOURCE_BODY),
    "sources/t/source.md": sourceNote(SOURCE_TWO_BODY),
    "knowledge/n.md": `# N\n\n${blocks.join("\n\n")}\n`,
    ...files,
  });
  return (await lintJson(root, "knowledge/n.md")).report;
}

async function codes(...blocks: string[]): Promise<string[]> {
  return (await lintNote(blocks)).findings.map((f) => f.code);
}

describe("quote matching", () => {
  test.each([
    [
      "straight quotes, a plain word, and a missing soft hyphen",
      '"A fine "quoted" cooperation was seen in every single trial run"',
    ],
    ["white space and line breaks", '"Many lines wrap across the page in this long sentence"'],
    ["escapes and math delimiters", '"Also 99% of 1.3 hours were recorded in the main run"'],
    [
      "a space before the percent sign",
      '"The top-1 score is 95% for ResNet-50 and DINOv2 (v2) on the closed-set protocol"',
    ],
    ["an elision", '"The set has 1093 … in the larger study"'],
    [
      "bracketed elisions in order",
      '"The set has 1093 monkeys [...] 3.5 layers in the larger study […] The top-1 score is 95%"',
    ],
    [
      "a quote under a subsection of its heading",
      '"Deep text here for the second section of this long page"',
    ],
  ])("passes %s", async (_name, quote) => {
    expect(await codes(callout("checked", "Text.", quote))).toEqual([]);
  });

  test.each([
    [
      "segments out of order",
      '"The top-1 score is 95% for ResNet-50 [...] The set has 1093 monkeys and 3.5"',
    ],
    ["the start of a longer number", '"93 monkeys and 3.5 layers in the larger study"'],
    ["the start of a longer decimal", '"The set has 1093 monkeys and 3"'],
    ["the middle of a word", '"The set has 1093 monkeys and 3.5 layers in the larg"'],
    ["text that is absent", '"The set has 34 monkeys and 3.5 layers in the larger study"'],
    ["a different case", '"the set has 1093 monkeys and 3.5 layers in the larger study"'],
  ])("fails %s", async (_name, quote) => {
    expect(await codes(callout("checked", "Text.", quote))).toEqual(["quote-not-in-source"]);
  });

  test("a quote under another heading is found only in that section", async () => {
    expect(await codes(callout("checked", "Text.", Q_OTHER))).toEqual(["quote-not-in-section"]);
    expect(
      await codes(callout("checked", "Text.", Q_SET, "[[sources/s/source#Deeper|S]]")),
    ).toEqual(["quote-not-in-section"]);
  });

  test("a heading link ignores case and the punctuation a link cannot hold", async () => {
    expect(
      await codes(callout("checked", "Text.", Q_OTHER, "[[sources/s/source#other|S]]")),
    ).toEqual([]);
  });
});

describe("quote length", () => {
  test.each([
    ["one word", '"the"'],
    ["a full stop", '"."'],
    ["a number between elisions", '"… 6,280 …"'],
    ["a single table cell", '"54.69"'],
    ["five words", '"The set has 1093 monkeys"'],
    ["a part of one word beside a long part", '"The set has 1093 monkeys and 3.5 [...] layers"'],
    ["a part of stop words only", '"The set has 1093 monkeys [...] To be or not to be"'],
    ["a part of numbers only", '"1093 3.5 6,280 2 3 4"'],
  ])("rejects %s", async (_name, quote) => {
    const link = quote === '"54.69"' ? TABLE : LINK;
    expect(await codes(callout("checked", "Text.", quote, link))).toEqual(["quote-too-short"]);
  });
});

describe("number matching", () => {
  test.each([
    ["a thousands separator the quote lacks", "It has 1,093 monkeys.", Q_SET],
    ["a thousands separator only the quote has", "It has 6280 images.", Q_RATES],
    ["a percent sign the quote has with a space", "It scores 95%.", Q_SCORE],
    ["the word percent where the quote has a percent sign", "It scores 95 percent.", Q_SCORE],
    ["a plus-minus sign the quote has", "A spread of ±2.", Q_RATES],
    ["a plus-minus sign written with a space", "A spread of ± 2.", Q_RATES],
    [
      "identifier digits the quote has no prefix for",
      "A top-1 ResNet-50 DINOv2 v2 L2 COVID-19 has 3.5 layers.",
      Q_SET,
    ],
    ["an identifier the quote repeats", "ResNet-50 reaches 95% top-1.", Q_SCORE],
    ["a hyphenated name the quote does not use", "Dataset-9999 has 3.5 layers.", Q_SET],
    ["a citation year in parentheses", "It has 3.5 layers (Shukla et al., 2018).", Q_SET],
    ["a citation year with one name", "It has 3.5 layers (Shukla, 2018).", Q_SET],
    [
      "a citation year with two names and a letter",
      "It has 3.5 layers (Shukla and Gao, 2018a).",
      Q_SET,
    ],
    ["a citation year after a name", "Shukla et al. (2018) found 3.5 layers.", Q_SET],
    ["a dotted version string", "It has 3.5 layers in v1.2.3.", Q_SET],
    ["a link label without its target", "It has 3.5 layers [[2018 notes|the notes]].", Q_SET],
    [
      "a Markdown link without its address",
      "It has 3.5 layers [here](https://example.org/5000).",
      Q_SET,
    ],
    ["both sides of a dimension", "It is resized to 224x224.", Q_RESIZE],
    ["a dimension with a multiplication sign", "It is resized to 224 × 224.", Q_RESIZE],
    ["an identifier written with and without a hyphen", "ResNet18 reached 97.97.", Q_R18],
    ["an identifier the quote writes without a hyphen", "ResNet-18 also reached 96.52.", Q_R18B],
    ["a superscript tag", "The dose was 10^4 cells.", Q_SUP],
    ["a mark that hid digits, with the digits right", "The sample size was 5000 animals.", Q_STAR],
    ["an amount with a currency code", "The fee was USD9999.", Q_FEE],
    ["a table row", "ResNet-18 closed set scores 54.69.", Q_ROW],
    ["a count whose footnote marker is dropped", "It counted 1399 images.", Q_MARKED],
    ["a value with a MathML plus-minus", "SphereFace reaches 90.82 ± 1.80 on lemurs.", Q_MATH],
    ["exponents the quote has", "The rate was 1e-3 and the decay 59e-9.", Q_EXP],
    ["a caret exponent against a superscript", "It ran 10^4 steps.", Q_EXP],
    ["a superscript exponent", "It ran 10⁴ steps.", Q_EXP],
    ["a currency amount", "The cost was US$9999.", Q_COST],
    ["a currency amount without its prefix", "The cost was 9999.", Q_COST],
  ])("passes %s", async (_name, text, quote) => {
    const link = quote === Q_ROW || quote === Q_MATH ? TABLE : LINK;
    expect(await codes(callout("checked", text, quote, link))).toEqual([]);
  });

  test.each([
    ["a number the quote lacks", "It has 3 layers.", Q_SET],
    ["a decimal with extra precision", "It has 3.50 layers.", Q_SET],
    ["a percent sign the quote lacks", "A spread of 2%.", Q_RATES],
    ["the word percent where the quote has no percent sign", "A spread of 2 percent.", Q_RATES],
    ["a plus-minus sign the quote lacks", "It has ±6,280 images.", Q_RATES],
    ["a bare year", "In 2018 it had 3.5 layers.", Q_SET],
    ["a year in parentheses without a name", "It has 3.5 layers (since 2018).", Q_SET],
    ["a year after a name in a count", "It has 3.5 layers (Rhesus, 2000 images).", Q_SET],
    ["a number in parentheses", "It has 3.5 layers (N = 1999).", Q_SET],
    ["a year in parentheses after a title", "The Dataset (2000) has 3.5 layers.", Q_SET],
    ["a number with a hyphen suffix", "A 5-fold set has 3.5 layers.", Q_SET],
    ["a separator moved", "It has 10,93 monkeys.", Q_SET],
    ["a mantissa the quote has with an exponent", "The decay was 5e-9.", Q_EXP],
    ["another exponent", "The rate was 1e-4.", Q_EXP],
    ["an exponent hidden by the base number", "It ran 10^3 steps.", Q_EXP],
    ["an exponent that is dropped", "The decay was 59.", Q_EXP],
    ["a currency amount that differs", "The cost was US$8888.", Q_COST],
    ["a currency amount with another prefix", "The cost was A$7777.", Q_COST],
    ["digits in an unlabeled link", "It has 3.5 layers [[2018 notes]].", Q_SET],
    ["a wrong second dimension", "It is resized to 224x300.", Q_RESIZE],
    ["a wrong dimension with a Unicode sign", "It is resized to 224×300.", Q_RESIZE],
    ["a wrong power after a sup tag", "The dose was 104 cells.", Q_SUP],
    ["a mark that hid digits", "The sample size was n*9999 animals.", Q_STAR],
    ["an amount with a currency code", "The fee was USD8888.", Q_FEE],
    ["a digit of another script", "The set has ٥٠٠٠ monkeys.", Q_SET],
    ["a digit for a number word", "It averages over 5 stratified splits.", Q_FIVE],
    ["a footnote number read as a count", "It counted 37 images.", Q_MARKED],
    ["a table row without its value", "ResNet-18 closed set scores 5469.", Q_ROW],
    ["digits in a link heading", "It has 3.5 layers [[knowledge/other#5000 more images]].", Q_SET],
    ["digits in an autolink", "It has 3.5 layers <https://example.org/5000-images>.", Q_SET],
    [
      "a number after a text that looks like a tag",
      "A set when n<m has 5000 and p>0.05 with 3.5 layers.",
      Q_SET,
    ],
  ])("fails %s", async (_name, text, quote) => {
    const link = quote === Q_ROW ? TABLE : LINK;
    expect(await codes(callout("checked", text, quote, link))).toEqual(["number-not-in-quote"]);
  });

  test("a link label is not read", async () => {
    const link = "[[sources/s/source#Data|5000 monkeys, a false label]]";
    expect(await codes(callout("checked", "It has 3.5 layers.", Q_SET, link))).toEqual([]);
  });

  test.each([
    ["fifty", "Fifty layers and 3.5 more."],
    ["a compound", "Two thousand layers, 3.5 of them."],
    ["half a dozen", "Half a dozen layers of 3.5."],
    ["twice", "It had twice the 3.5 layers."],
    ["one", "One of the 3.5 layers."],
    ["percent without a digit", "A percent of 3.5 layers."],
    ["thousands", "Thousands of layers, 3.5 of them."],
    ["hundreds", "Hundreds of 3.5 layers."],
    ["dozens", "Dozens of 3.5 layers."],
    ["doubled", "It doubled the 3.5 layers."],
    ["tripled", "It tripled the 3.5 layers."],
    ["halved", "It halved the 3.5 layers."],
    ["quadrupled", "It quadrupled the 3.5 layers."],
    ["couple", "A couple of 3.5 layers."],
    ["one-hot", "A one-hot code of 3.5 layers."],
    ["double-blind", "A double-blind run of 3.5 layers."],
  ])("rejects the number word %s in a fact", async (_name, text) => {
    expect(await codes(callout("checked", text, Q_SET))).toEqual(["number-word"]);
  });

  test.each([
    ["ordinals", "The first and second of the 3.5 layers."],
    ["several", "Several of the 3.5 layers."],
    ["single", "A single one-off of 3.5 layers"],
  ])("does not reject %s", async (_name, text) => {
    const found = await codes(callout("checked", text, Q_SET));
    expect(found.includes("number-word")).toBe(text.includes("one-off"));
  });

  test("a number word the quote uses too can be checked", async () => {
    expect(
      await codes(callout("checked", "It averages over five stratified splits.", Q_FIVE)),
    ).toEqual([]);
    expect(
      await codes(callout("checked", "It averages over six stratified splits.", Q_FIVE)),
    ).toEqual(["number-word"]);
    // A number word is the source's own only as a whole word: `six` is not `sixteen`.
    expect(await codes(callout("checked", "It kept six stratified splits.", Q_SIXTEEN))).toEqual([
      "number-word",
    ]);
  });

  test.each([
    ["a different prefix number", "ResNet-101 reaches 95% top-1.", Q_SCORE],
    [
      "an attached identifier with other digits",
      "AlexNet Pool4 features with PCA were the best.",
      Q_POOL,
    ],
    ["an attached identifier against a hyphenated one", "ResNet101 reached 97.97.", Q_R18],
    ["a hyphenated identifier against an attached one", "ResNet-101 also reached 96.52.", Q_R18B],
    ["a different top-k", "The top-5 score is 95%.", Q_SCORE],
  ])("rejects an identifier the quote names with other digits: %s", async (_name, text, quote) => {
    expect(await codes(callout("checked", text, quote))).toEqual(["identifier-mismatch"]);
  });
});

describe("minus signs", () => {
  const MINUS_SIGN = String.fromCharCode(0x2212);
  const EN_DASH = String.fromCharCode(0x2013);

  test.each([
    ["a hyphen-minus", "It changed by -3.2 points.", Q_CHANGE],
    ["a Unicode minus against a hyphen-minus", `It changed by ${MINUS_SIGN}3.2 points.`, Q_CHANGE],
    [
      "an en dash used as a minus after a parenthesis",
      `A change (${EN_DASH}3.2 points).`,
      Q_CHANGE,
    ],
    ["a positive number against a positive number", "It gained 3.2 points.", Q_GAIN],
    ["both ends of a range", "Over 10-20 folds it changed by -3.2.", Q_CHANGE],
    ["a range written with an en dash", `Over 10${EN_DASH}20 folds.`, Q_CHANGE],
  ])("passes %s", async (_name, text, quote) => {
    expect(await codes(callout("checked", text, quote))).toEqual([]);
  });

  test.each([
    [
      "a positive fact number against a negative quote number",
      "It changed by 3.2 points.",
      Q_CHANGE,
    ],
    [
      "a negative fact number against a positive quote number",
      "It changed by -3.2 points.",
      Q_GAIN,
    ],
    ["a Unicode minus against a positive quote number", `A change of ${MINUS_SIGN}3.2.`, Q_GAIN],
    ["the end of a range read as negative", "Over -20 folds.", Q_CHANGE],
    ["a range end missing from the quote", "Over 10-30 folds.", Q_CHANGE],
  ])("fails %s", async (_name, text, quote) => {
    expect(await codes(callout("checked", text, quote))).toEqual(["number-not-in-quote"]);
  });
});

describe("normalization", () => {
  test.each([
    ["a superscript exponent", "10⁴ and 10⁻⁴", "10^4 and 10^-4"],
    ["marks between digits", "3*5 and 3`5 and 3$5", "3 5 and 3 5 and 3 5"],
    ["a dollar sign after a letter and before a digit", "US$5 and A$7", "US$5 and A$7"],
    ["math delimiters", "$1.3$ hours and $n$ images", "1.3 hours and n images"],
    ["LaTeX symbols", "97.97 $\\pm$ 0.70, $224\\times 224$", "97.97 ± 0.70, 224 × 224"],
    ["LaTeX comparisons", "$a \\le b \\leq c \\ge d \\geq e \\approx f$", "a ≤ b ≤ c ≥ d ≥ e ≈ f"],
    ["a LaTeX exponent in braces", "$10^{-3}$", "10^-3"],
    ["a plus-slash-minus", "5 +/- 2", "5 ± 2"],
    ["a text that only looks like a tag", "when n<m and p>0.05", "when n<m and p>0.05"],
    ["a superscript after a digit", "10<sup>4</sup>", "10^4"],
    ["a superscript after a parenthesis", "(a+b)<sup>2</sup>", "(a+b)^2"],
    [
      "a superscript after a letter, which is a marker",
      "x<sup>2</sup> and a <sup>1</sup>.",
      "x and a .",
    ],
    [
      "a superscript that holds a link, which is a marker",
      '1399 images<sup><a href="#fn:37">37</a></sup> of',
      "1399 images of",
    ],
    ["a power that holds a link, which is a marker", "10<sup><a>37</a></sup>", "10"],
    ["a subscript tag", "H<sub>2</sub>O", "H_2O"],
    ["table cells", "<td>54.69</td><td>65.92</td>", "54.69 65.92"],
    [
      "MathML with its LaTeX annotation",
      "1 <math><semantics><mo>±</mo> <annotation>\\pm</annotation></semantics></math> 2",
      "1 ± 2",
    ],
    ["a mark between a letter and digits", "n*5000 and n`5000", "n 5000 and n 5000"],
    ["a mark between digits and a letter", "5*x and 5`x", "5 x and 5 x"],
    ["digits of another script", "٥٠٠٠ and ５０００ and ०१२", "5000 and 5000 and 012"],
  ])("maps %s", (_name, input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  test("quote text that renders the LaTeX row matches the source row", async () => {
    const row = "ResNet-18+Cross Entropy | 97.97 ± 0.70 | 96.52 ± 1.95 | 98.08 ± 0.45";
    const body =
      "## Table\n\n| ResNet-18+Cross Entropy | 97.97 $\\pm$ 0.70 | 96.52 $\\pm$ 1.95 | 98.08 $\\pm$ 0.45 |\n";
    const link = "[[sources/s/source#Table|S]]";
    const lint = await lintNote(
      [callout("checked", "ResNet-18 reaches 97.97 ± 0.70.", `"${row}"`, link)],
      { "sources/s/source.md": sourceNote(body) },
    );
    expect(lint.findings).toEqual([]);
  });
});

describe("linear time", () => {
  const MB200 = 200_000;
  test.each([
    ["links that never close", "[a](".repeat(MB200 / 4)],
    ["brackets that never close", "[^".repeat(MB200 / 2)],
    ["labels without a target", "[a]".repeat(MB200 / 3)],
    ["tags that never close", "<a ".repeat(MB200 / 3)],
    ["escapes", "\\$".repeat(MB200 / 2)],
    ["white space", `a${" ".repeat(MB200)}b`],
    ["marks between digits", "1*".repeat(MB200 / 2)],
    ["math delimiters", "$a".repeat(MB200 / 2)],
    ["superscript tags that never close", "<sup>".repeat(MB200 / 5)],
    ["annotations that never close", "<annotation>".repeat(MB200 / 12)],
    ["digits of another script", "٥".repeat(MB200)],
  ])("normalizes %s in under a second", (_name, text) => {
    const start = performance.now();
    normalizeText(text);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("lints a source with adversarial lines in under a second", async () => {
    const body = `## Data\n\n${"[a](".repeat(50_000)}\n\n# ${" ".repeat(100_000)}x\n\n${"#".repeat(100_000)}\n\n${"1,".repeat(50_000)}\n`;
    const start = performance.now();
    const report = await lintNote([callout("checked", "It has 3.5 layers.", Q_SET)], {
      "sources/s/source.md": sourceNote(body),
    });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(report.findings.map((f) => f.code)).toEqual(["quote-not-in-source"]);
  });
});

describe("structure and status", () => {
  const block = (extra: string) => `> [!fact] checked\n> T.\n> > ${Q_SET}\n${extra}`;
  test.each([
    ["an unknown status", callout("draftd", "T.", Q_SET), "unknown-status"],
    ["a flagged status without a reason", callout("flagged", "T.", null), "unknown-status"],
    [
      "a foldable callout",
      callout("checked", "T.", Q_SET).replace("[!fact]", "[!fact]-"),
      "unknown-status",
    ],
    ["no block ID", callout("checked", "T.", Q_SET, undefined, null), "missing-block-id"],
    [
      "a block ID with the wrong prefix",
      callout("checked", "T.", Q_SET, undefined, "^x-1"),
      "malformed",
    ],
    ["no quote", callout("checked", "T.", null), "malformed"],
    ["a quote without quotation marks", callout("checked", "T.", Q_SET.slice(1, -1)), "malformed"],
    [
      "two quotes",
      `> [!fact] checked\n> T.\n> > ${Q_SET}\n>\n> > ${Q_OTHER}\n> — ${LINK}\n\n^fact-x`,
      "malformed",
    ],
    ["text after the source line", `${block(`> — ${LINK}\n> more`)}\n\n^fact-x`, "malformed"],
    ["an embed in the fact", callout("checked", "T. ![[knowledge/other]]", Q_SET), "malformed"],
    [
      "a source line with text after the link",
      callout("checked", "T.", Q_SET, `${LINK} and also 5000 more`),
      "bad-source-link",
    ],
    [
      "a source line without a link",
      callout("checked", "T.", Q_SET, "Shukla 2018"),
      "bad-source-link",
    ],
    [
      "a link to a note that is not a source",
      callout("checked", "T.", Q_SET, "[[knowledge/n#Data|N]]"),
      "bad-source-link",
    ],
    [
      "a link without a heading",
      callout("checked", "T.", Q_SET, "[[sources/s/source|S]]"),
      "missing-heading",
    ],
    [
      "a heading the source lacks",
      callout("checked", "T.", Q_SET, "[[sources/s/source#Nope|S]]"),
      "heading-not-found",
    ],
    [
      "a heading the source repeats",
      callout(
        "checked",
        "T.",
        '"First section text for the repeated heading here today"',
        "[[sources/s/source#Twice|S]]",
      ),
      "ambiguous-heading",
    ],
  ])("finds %s", async (_name, text, code) => {
    expect(await codes(text)).toEqual([code]);
  });

  test("a block ID directly under the callout is malformed; two blank lines leave it missing", async () => {
    const joined = callout("checked", "T.", Q_SET).replace("\n\n^fact-x", "\n^fact-x");
    expect(await codes(joined)).toEqual(["malformed"]);
    const apart = callout("checked", "T.", Q_SET).replace("\n\n^fact-x", "\n\n\n^fact-x");
    expect(await codes(apart)).toEqual(["missing-block-id"]);
  });

  test("a block ID is unique in its note", async () => {
    const report = await lintNote([
      callout("checked", "T.", Q_SET),
      callout("checked", "T.", Q_SET),
    ]);
    expect(report.findings.map((f) => [f.code, f.claim])).toEqual([
      ["duplicate-block-id", "fact-x"],
    ]);
  });

  test("a flagged fact is reported and does not fail; a superseded fact is skipped", async () => {
    const flagged = callout("flagged: not captured", "Gao reports 96.3%.", null, "Gao 2026", null);
    const superseded = callout(
      "superseded",
      "It has 7 layers.",
      '"not in the source"',
      LINK,
      "^fact-old",
    );
    const report = await lintNote([
      flagged,
      superseded,
      callout("checked", "It has 3.5 layers.", Q_SET),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.flagged.map((f) => f.reason)).toEqual(["not captured"]);
    expect(report.by_status).toMatchObject({ flagged: 1, superseded: 1, checked: 1 });
    expect(report.fully_checked).toBe(1);
  });

  test("a superseded fact still holds its block ID", async () => {
    const superseded = callout("superseded", "Old.", '"gone"');
    expect(await codes(superseded, callout("checked", "T.", Q_SET))).toEqual([
      "duplicate-block-id",
    ]);
  });

  test("a malformed flagged fact fails", async () => {
    expect(await codes("> [!fact] flagged: why\n> Only text.\n")).toEqual(["malformed"]);
  });

  test("an example inside a code fence is not linted", async () => {
    const fenced = `\`\`\`markdown\n${callout("nonsense", "T.", null)}\n\`\`\``;
    expect(await codes(fenced)).toEqual([]);
  });

  test("a fact is not hidden by a fence opener with a backtick in its info string", async () => {
    const wrong = callout("checked", "It has 5000 layers.", Q_SET);
    expect(await codes(`\`\`\`a\`b\n\n${wrong}`)).toEqual(["number-not-in-quote"]);
  });

  test("a fence that is never closed gives a warning and does not fail", async () => {
    const report = await lintNote(["```\ncode\n"]);
    expect(report.findings).toEqual([]);
    expect(report.warnings.map((w) => w.message)).toEqual([
      "fence opened at line 3 is never closed; 4 lines not linted",
    ]);
  });

  test("a closing fence has no text after it", async () => {
    const wrong = callout("checked", "It has 5000 layers.", Q_SET);
    // `~~~ x` does not close the fence, so the fact is still code.
    expect(await codes(`~~~\ncode\n~~~ x\n\n${wrong}\n\n~~~`)).toEqual([]);
    expect(await codes(`~~~\ncode\n~~~\n\n${wrong}`)).toEqual(["number-not-in-quote"]);
  });
});

describe("callouts that are not parsed", () => {
  const fact = (start: string) =>
    `${start}\n> It has 5000 layers.\n> > ${Q_SET}\n> — ${LINK}\n\n^fact-x`;
  test.each([
    ["two spaces after the marker", fact(">  [!fact] checked")],
    ["a list item", `- > [!fact] checked\n  > It has 5000 layers.\n  > > ${Q_SET}\n  > — ${LINK}`],
    [
      "a nested quote",
      `> > [!fact] checked\n> > It has 5000 layers.\n> > > ${Q_SET}\n> > — ${LINK}`,
    ],
    ["a misspelled type", fact("> [!facts] checked")],
    ["an indented start", fact("    > [!fact] checked")],
    [
      "a callout that follows another without a blank line",
      `${callout("checked", "It has 3.5 layers.", Q_SET).split("\n\n")[0]}\n> [!fact] drafted`,
    ],
  ])("reports %s", async (_name, text) => {
    expect(await codes(text)).toContain("malformed");
  });

  test("a mention in prose or in a fence is not a callout", async () => {
    expect(await codes("Use a `[!fact]` callout.\n\n```\n> [!fact]\n```")).toEqual([]);
  });
});

describe("source integrity", () => {
  const cited = callout("checked", "It has 3.5 layers.", Q_SET);
  const hash = createHash("sha256").update(SOURCE_BODY).digest("hex");

  test.each([
    ["a text hash that does not match", { sha256_text: "0".repeat(64) }],
    ["no text hash", { sha256_text: null }],
    ["no source ID", { source_id: null }],
  ])("a source with %s fails the facts that cite it", async (_name, manifest) => {
    const report = await lintNote([cited], {
      "sources/s/source.md": sourceNote(SOURCE_BODY, manifest),
    });
    expect(report.findings.map((f) => f.code)).toEqual(["source-integrity"]);
    expect(report.fully_checked).toBe(0);
  });

  test("a source that was changed after capture fails", async () => {
    const changed = sourceNote(SOURCE_BODY, { sha256_text: hash }).replace("1093", "1099");
    const report = await lintNote([cited], { "sources/s/source.md": changed });
    expect(report.findings.map((f) => f.code)).toContain("source-integrity");
  });

  test("a source that nothing cites is not checked", async () => {
    const report = await lintNote([cited], {
      "sources/t/source.md": sourceNote(SOURCE_TWO_BODY, { sha256_text: "0".repeat(64) }),
    });
    expect(report.findings).toEqual([]);
  });
});

describe("conflicts", () => {
  const pair = (quote: string, link = LINK) => `> > ${quote}\n> — ${link}`;
  const conflict = (statement: string, ...pairs: string[]) =>
    `> [!conflict] open\n> ${statement}\n${pairs.join("\n")}\n\n^conflict-c`;
  const SECOND = "[[sources/t/source#Data|T]]";
  const Q_SECOND = '"Our dataset reports 6,380 images in total over all the folds"';

  test("each quote is checked against its own source section", async () => {
    expect(
      await codes(conflict("Image counts differ.", pair(Q_RATES), pair(Q_SECOND, SECOND))),
    ).toEqual([]);
    expect(
      await codes(
        conflict(
          "Image counts differ.",
          pair(Q_RATES),
          pair(Q_SECOND, "[[sources/t/source#Nope|T]]"),
        ),
      ),
    ).toEqual(["heading-not-found"]);
  });

  test("a number of the statement must occur in one of the quotes", async () => {
    const two = [pair(Q_RATES), pair(Q_SECOND, SECOND)];
    expect(await codes(conflict("It has 6280 or 6,380 images.", ...two))).toEqual([]);
    expect(await codes(conflict("It has 6280 or 7000 images.", ...two))).toEqual([
      "number-not-in-quote",
    ]);
  });

  test("a conflict needs two quotes from two different sources", async () => {
    expect(await codes(conflict("Image counts differ.", pair(Q_RATES)))).toEqual(["malformed"]);
    expect(await codes(conflict("Image counts differ.", pair(Q_RATES), pair(Q_SET)))).toEqual([
      "malformed",
    ]);
    const copy = { "sources/t/source.md": sourceNote(SOURCE_BODY) };
    const same = conflict("Image counts differ.", pair(Q_RATES), pair(Q_RATES, SECOND));
    expect((await lintNote([same], copy)).findings.map((f) => f.code)).toEqual(["malformed"]);
  });

  test("a conflict needs a known status", async () => {
    const text = conflict("S.", pair(Q_RATES), pair(Q_SECOND, SECOND)).replace("open", "closed");
    expect(await codes(text)).toEqual(["unknown-status"]);
  });
});
