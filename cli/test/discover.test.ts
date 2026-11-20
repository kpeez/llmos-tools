/**
 * `llmos discover` and the `overdue_jobs` section of `health` that
 * reads its record (the `discovered` property of `categories/Knowledge.md`),
 * on temporary vaults (never the real one).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { extractIds, findClusters, MAX_KEY_NOTES, similarPairs } from "../src/discover.ts";
import { VaultModel } from "../src/vault.ts";
import { cli, isolatedEnv, makeVault, scratch, TODAY, writeFiles } from "./helpers.ts";

describe("extractIds", () => {
  const cases: [string, string, string[]][] = [
    [
      "URLs and versions",
      "https://arxiv.org/abs/2403.11111v2 and arxiv.org/pdf/2403.22222.pdf",
      ["arxiv:2403.11111", "arxiv:2403.22222"],
    ],
    [
      "arXiv: prefix and slug",
      "arXiv:2403.11111, raw/arxiv-2403.33333v1/",
      ["arxiv:2403.11111", "arxiv:2403.33333"],
    ],
    [
      "the number has 4 digits up to 1412 and 5 digits from 1501",
      "2403.4444 1203.4567 1203.12345 1412.1234 1501.12345 1501.1234",
      ["arxiv:1203.4567", "arxiv:1412.1234", "arxiv:1501.12345"],
    ],
    [
      "tail of a DOI is no id",
      "10.1111/nph.2095-8137.2024.296 and 2095-8137.2024.296",
      ["doi:10.1111/nph.2095-8137.2024.296"],
    ],
    [
      "DOI ends at a delimiter, loses trailing punctuation, is lower-case",
      "(https://doi.org/10.1234/AbC.5), then 10.9999/x.y. and **10.8888/z**, `10.7777/w`: 10.6666/v?!",
      ["doi:10.1234/abc.5", "doi:10.6666/v", "doi:10.7777/w", "doi:10.8888/z", "doi:10.9999/x.y"],
    ],
    ["arXiv DOI reads as the arXiv id", "10.48550/arXiv.2403.11111v2", ["arxiv:2403.11111"]],
    [
      "bioRxiv DOI loses its .full suffix and version",
      "10.1101/2024.03.12.123456v2 10.1101/2024.03.12.123457v1.full 10.1101/2024.03.12.123458.full.pdf 10.1101/2024.03.12.123459v3.full-text",
      [
        "doi:10.1101/2024.03.12.123456",
        "doi:10.1101/2024.03.12.123457",
        "doi:10.1101/2024.03.12.123458",
        "doi:10.1101/2024.03.12.123459",
      ],
    ],
    [
      "a 5-digit id needs a year that is not in the future (2026 here); 4 digits need 0704-1412",
      "9912.12345 3512.12345 2612.12345 0703.9999 0704.0001",
      ["arxiv:0704.0001", "arxiv:2612.12345"],
    ],
    [
      "an undated 10.1101 DOI loses its suffix and version",
      "10.1101/123456v3.full 10.1101/123457v1.abstract 10.1101/123458v2.supplementary-material 10.1101/123459v3",
      ["doi:10.1101/123456", "doi:10.1101/123457", "doi:10.1101/123458", "doi:10.1101/123459"],
    ],
    [
      "balanced parentheses stay in a DOI, an unbalanced one does not",
      "10.1016/s0140-6736(20)30183-5 (see 10.1234/abc)",
      ["doi:10.1016/s0140-6736(20)30183-5", "doi:10.1234/abc"],
    ],
    [
      "a DOI followed by < or > is dropped (SICI and AMS forms), unless it is an autolink",
      "10.1002/(SICI)1097-0258(19980430)17:8<873::AID-SIM792>3.0.CO;2-I 10.1002/(SICI)1097-0258(19980430)17:8<889::AID-SIM800>3.0.CO;2-X 10.1175/1520-0477(1996)077<0437:TNYRP>2.0.CO;2 10.1175/1520-0477(1996)077<0001:ABCDE>2.0.CO;2 <https://doi.org/10.1038/s41586-020-2649-2> <10.1371/journal.pone.0123456> 10.1234/ends>here",
      ["doi:10.1038/s41586-020-2649-2", "doi:10.1371/journal.pone.0123456"],
    ],
    [
      "%2F, %28, and %29 are decoded in a DOI",
      "https://doi.org/10.1038%2Fs41586-020-2649-2 10.1016%2fS0140-6736%2820%2930183-5",
      ["doi:10.1016/s0140-6736(20)30183-5", "doi:10.1038/s41586-020-2649-2"],
    ],
    [
      "a publisher page suffix is dropped",
      "https://onlinelibrary.wiley.com/doi/10.1111/jpi.12345/full 10.1111/jpi.12346/abstract 10.1111/jpi.12347/pdf 10.1111/jpi.12348/epdf",
      [
        "doi:10.1111/jpi.12345",
        "doi:10.1111/jpi.12346",
        "doi:10.1111/jpi.12347",
        "doi:10.1111/jpi.12348",
      ],
    ],
  ];
  test.each(cases)("%s", (_name, text, expected) => {
    expect(extractIds(text, new Date(2026, 9, 8))).toEqual(expected);
  });
});

const note = (body: string, front = ""): string =>
  `---\ncreated: "2026-10-01"\n${front}---\n\n# Note\n\n${body}\n`;

const model = (files: Record<string, string>): VaultModel => VaultModel.load(makeVault(files));

/** `n` notes in `folder` that share two DOIs; the first `linkers` also link the knowledge note. */
function group(n: number, linkers: number, folder = "projects", fillers = 5): VaultModel {
  const files: Record<string, string> = { "knowledge/hub.md": note("The hub.") };
  for (let i = 0; i < n; i++) {
    files[`${folder}/m${i}.md`] = note(`10.1234/a 10.1234/b${i < linkers ? " [[hub]]" : ""}`);
  }
  for (let i = 0; i < fillers; i++) files[`projects/filler${i}.md`] = note(`10.8888/own${i}`);
  return model(files);
}

describe("findClusters", () => {
  test("a note that cites many works does not bridge two clusters", () => {
    const ids = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `arXiv:24${prefix}.${10001 + i}`);
    const [a, b] = [ids("01", 3), ids("02", 3)];
    const fillers = ids("03", 10);
    const files: Record<string, string> = {
      "notes/bridge.md": `# Bridge\n\n${[...a, ...b, ...fillers].join(" ")}\n`,
    };
    for (const i of [1, 2, 3]) {
      files[`notes/a${i}.md`] = `# A${i}\n\n${a.join(" ")}\n`;
      files[`notes/b${i}.md`] = `# B${i}\n\n${b.join(" ")}\n`;
    }
    fillers.forEach((id, i) => {
      files[`notes/filler${i}.md`] = `# Filler ${i}\n\n${id}\n`;
    });

    const clusters = findClusters(VaultModel.load(makeVault(files)));

    expect(clusters.map((cluster) => cluster.notes)).toEqual([
      ["notes/a1.md", "notes/a2.md", "notes/a3.md"],
      ["notes/b1.md", "notes/b2.md", "notes/b3.md"],
    ]);
  });

  test("the overlap divides by the union: the shared weight is counted once", () => {
    // Five candidates (AGENTS.md counts), so a key shared by 3 notes weighs ln(5/3) and by
    // 2 notes ln(5/2). a-b and a-c share two of a's six keys: the overlap is 0.218 (0.179
    // if the union did not subtract the shared part), and a also links x through four keys.
    const doi = (n: number) => `10.1000/k${n}`;
    const clusters = findClusters(
      model({
        "notes/a.md": note([1, 2, 3, 4, 5, 6].map(doi).join(" ")),
        "notes/b.md": note([1, 2].map(doi).join(" ")),
        "notes/c.md": note([1, 2].map(doi).join(" ")),
        "notes/x.md": note([3, 4, 5, 6].map(doi).join(" ")),
      }),
    );
    expect(clusters.map((cluster) => cluster.notes)).toEqual([
      ["notes/a.md", "notes/b.md", "notes/c.md", "notes/x.md"],
    ]);
  });

  test("notes that hold every key weigh nothing and form no cluster", () => {
    // The vault's AGENTS.md is a candidate too, so it holds the keys as well: 4 of 4 notes.
    const keys = note("10.1234/a 10.1234/b");
    const files = { "AGENTS.md": keys, "n/1.md": keys, "n/2.md": keys, "n/3.md": keys };
    expect(findClusters(model(files))).toEqual([]);
  });

  test("an embed of an existing Base or image is no dangling link", () => {
    // Project landing notes embed `![[Reviews.base#Project]]`; the file exists, so it joins nothing.
    const embeds = "![[Reviews.base#Project]]\n![[Decisions.base]]\n![[figures/plot.png]]\n";
    const files: Record<string, string> = {
      "categories/Reviews.base": "views: []\n",
      "categories/Decisions.base": "views: []\n",
      "figures/plot.png": "png",
    };
    for (const i of [1, 2, 3]) files[`projects/p${i}/p${i}.md`] = `# P${i}\n\n${embeds}`;
    expect(findClusters(VaultModel.load(makeVault(files)))).toEqual([]);

    // A target that names no file or note still counts as dangling.
    for (const i of [1, 2, 3])
      files[`projects/p${i}/p${i}.md`] = `# P${i}\n\n[[Gone A]] [[Gone B]]\n`;
    expect(findClusters(VaultModel.load(makeVault(files)))).toHaveLength(1);
  });

  test("a key held by more than MAX_KEY_NOTES notes links nothing", () => {
    expect(findClusters(group(MAX_KEY_NOTES, 0))).toHaveLength(1);
    expect(findClusters(group(MAX_KEY_NOTES + 1, 0))).toEqual([]);
  });

  test("notes in knowledge/, daily/, categories/ and the vault's rule notes are not candidates", () => {
    for (const folder of ["knowledge", "daily", "categories", "categories/templates"]) {
      expect(findClusters(group(3, 0, folder))).toEqual([]);
    }
    expect(findClusters(group(3, 0))).toHaveLength(1);
    const keys = note("10.1234/a 10.1234/b");
    const rules = { "schema.md": keys, "authoring.md": keys, "ingest-contract.md": keys };
    expect(findClusters(model(rules))).toEqual([]);
  });

  test("captured sources are not candidates; inbox drops in raw/, nested or not, are", () => {
    const keys = note("10.1234/a 10.1234/b");
    const captures = {
      "raw/s1/source.md": keys,
      "raw/s2/source.md": keys,
      "raw/s3/source.md": keys,
    };
    expect(findClusters(model(captures))).toEqual([]);
    expect(findClusters(group(3, 0, "raw"))).toHaveLength(1);
    expect(findClusters(group(3, 0, "raw/batch"))).toHaveLength(1);
  });

  test.each([
    ["exactly half of the notes link it", 4, 2, "knowledge/hub.md"],
    ["just under half link it", 5, 2, null],
  ] as const)("covered_by: %s", (_name, size, linkers, covered) => {
    const [cluster] = findClusters(group(size, linkers));
    expect(cluster?.notes).toHaveLength(size);
    expect(cluster?.covered_by).toBe(covered);
  });
});

describe("similarPairs", () => {
  test("keeps only the mutual nearest neighbors", () => {
    // Points on a circle (degrees); a larger angle gap is a lower cosine. With 2 neighbors
    // each: d0 {d1,d2}, d1 {d0,d2}, d2 {d1,d3}, d3 {d2,d4}, d4 {d3,d5}, d5 {d4,d3}, far {d5,d4}.
    const angles: Record<string, number> = {
      d0: 0,
      d1: 10,
      d2: 21,
      d3: 33,
      d4: 46,
      d5: 60,
      far: 150,
    };
    const vectors = new Map(
      Object.entries(angles).map(([path, degrees]) => {
        const radians = (degrees * Math.PI) / 180;
        return [path, new Float32Array([Math.cos(radians), Math.sin(radians)])];
      }),
    );

    const pairs = similarPairs(vectors, [...Object.keys(angles), "no-vector"], 2);

    expect(pairs.map((pair) => `${pair.a} ${pair.b}`).sort()).toEqual([
      "d0 d1",
      "d1 d2",
      "d2 d3",
      "d3 d4",
      "d4 d5",
    ]);
    expect(pairs.find((pair) => pair.a === "d0")?.cosine).toBeCloseTo(0.985, 3);
  });
});

/** Every file of the vault with its text. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of new Bun.Glob("**/*").scanSync({ cwd: root, dot: true })) {
    files[path] = readFileSync(join(root, path), "utf8");
  }
  return files;
}

/** The vault paths whose text differs between two snapshots. */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

const KNOWLEDGE_NOTE = "categories/Knowledge.md";
const REVIEWS_NOTE = "categories/Reviews.md";

describe("health overdue_jobs", () => {
  /**
   * A vault with no finding when both records are current: every note links
   * and is linked. `front` and `digest` are the frontmatter lines of the
   * Knowledge and Reviews notes; null leaves that note out.
   */
  function cleanVault(
    front: string | null,
    digest: string | null = `digested: ${TODAY}\n`,
  ): string {
    const head = '---\ncreated: "2026-10-01"\n---\n\n';
    const root = join(scratch("vault"), "llmOS");
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    const links = [front === null ? "" : " [[Knowledge]]", digest === null ? "" : " [[Reviews]]"];
    writeFiles(root, {
      "AGENTS.md": `${head}# Guide\n\n[[a]]\n`,
      "notes/a.md": `${head}# A\n\n[[b]] [[AGENTS]]${links.join("")}\n`,
      "notes/b.md": `${head}# B\n\n[[a]]\n`,
    });
    if (front !== null) {
      writeFiles(root, {
        [KNOWLEDGE_NOTE]: `---\ncreated: "2026-10-01"\n${front}---\n\n# Knowledge\n\n[[a]]\n`,
      });
    }
    if (digest !== null) {
      writeFiles(root, {
        [REVIEWS_NOTE]: `---\ncreated: "2026-10-01"\n${digest}---\n\n# Reviews\n\n[[a]]\n`,
      });
    }
    return root;
  }

  test.each([
    ["the note is missing", null, null, 1],
    ["the value is not a date", 'discovered: "last tuesday"\n', "last tuesday", 1],
    ["the date is 2 days ahead", "discovered: 2026-10-09\n", "2026-10-09", 1],
    ["the date is 1 day ahead (clock skew)", "discovered: 2026-10-08\n", undefined, 0],
    ["the date does not exist", "discovered: 2026-02-30\n", "2026-02-30", 1],
    ["the date is 11 days old", "discovered: 2026-09-26\n", "2026-09-26", 1],
    ["the date is 10 days old", "discovered: 2026-09-27\n", undefined, 0],
  ] as const)("%s", async (_name, front, lastSuccess, exitCode) => {
    const root = cleanVault(front);
    const result = await cli(root, ["health", "--json"]);
    const report = JSON.parse(result.stdout) as { overdue_jobs: unknown[] };
    expect(result.exitCode).toBe(exitCode);
    expect(report.overdue_jobs).toEqual(
      exitCode === 0 ? [] : [{ job: "discover", last_success: lastSuccess, max_age_days: 10 }],
    );
    const text = await cli(root, ["health"]);
    expect(text.stdout.includes("overdue jobs (1): discover")).toBe(exitCode === 1);
  });

  test.each([
    ["the date is 4 days old", "digested: 2026-10-03\n", "2026-10-03", 1],
    ["the date is 3 days old", "digested: 2026-10-04\n", undefined, 0],
    ["the date is 2 days ahead", "digested: 2026-10-09\n", "2026-10-09", 1],
  ] as const)("the digest record: %s", async (_name, digest, lastSuccess, exitCode) => {
    const root = cleanVault(`discovered: ${TODAY}\n`, digest);
    const result = await cli(root, ["health", "--json"]);
    expect(result.exitCode).toBe(exitCode);
    expect(JSON.parse(result.stdout).overdue_jobs).toEqual(
      exitCode === 0 ? [] : [{ job: "daily-activity", last_success: lastSuccess, max_age_days: 3 }],
    );
  });

  test("a note of the same name in another folder does not count", async () => {
    const root = cleanVault("discovered: 2026-09-01\n");
    writeFiles(root, { "notes/Knowledge.md": "---\ndiscovered: 2026-10-07\n---\n\n# Other\n" });
    const result = await cli(root, ["health", "--json"]);
    expect(JSON.parse(result.stdout).overdue_jobs).toEqual([
      { job: "discover", last_success: "2026-09-01", max_age_days: 10 },
    ]);
  });

  test("a wikilink never joins a DOI key", () => {
    const keys = extractIds("[[10.1234/abc/Secret Name]] 10.1234/def[[Other Secret]]");
    expect(keys).toEqual(["doi:10.1234/def"]);
    expect(extractIds("[[raw/arxiv-2403.11111v1]]", new Date(2026, 9, 8))).toEqual([
      "arxiv:2403.11111",
    ]);
  });

  test("a link to the Knowledge note, and the create verb, cannot set the run record either", async () => {
    const root = cleanVault("discovered: 2026-09-01\n");
    symlinkSync(join(root, KNOWLEDGE_NOTE), join(root, "notes/alias.md"));
    const before = snapshot(root);
    const alias = await cli(root, ["set-property", "notes/alias.md", "discovered", "2026-10-07"]);
    expect(alias.exitCode).toBe(1);
    expect(alias.stderr).toContain("only `llmos discover` sets it");
    expect(snapshot(root)).toEqual(before);

    const fresh = cleanVault(null);
    const create = await cli(fresh, [
      "create",
      "categories/./Knowledge",
      "--content",
      "---\ncreated: 2026-10-01\ndiscovered: 2026-10-07\n---\n\nK",
    ]);
    expect(create.exitCode).toBe(1);
    expect(existsSync(join(fresh, KNOWLEDGE_NOTE))).toBe(false);
    const crlf = await cli(fresh, [
      "create",
      "categories/Knowledge",
      "--content",
      "---\r\ncreated: 2026-10-01\r\ndiscovered: 2026-10-07\r\n---\r\n\r\nK",
    ]);
    expect(crlf.exitCode).toBe(1);
    expect(existsSync(join(fresh, KNOWLEDGE_NOTE))).toBe(false);
    const plain = await cli(fresh, ["create", "categories/Knowledge", "--content", "# K"]);
    expect(plain.exitCode).toBe(0);
  });

  test("a plain vault may set a property named discovered", async () => {
    const root = cleanVault("discovered: 2026-09-01\n");
    const result = await cli(root, [
      "set-property",
      KNOWLEDGE_NOTE,
      "discovered",
      "2026-10-07",
      "--vault",
      "notebook",
    ]);
    expect(result.exitCode).toBe(0);
  });

  test("the run record of discover cannot be set or removed by hand", async () => {
    const root = cleanVault("discovered: 2026-09-01\n");
    const before = snapshot(root);
    for (const argv of [
      ["set-property", KNOWLEDGE_NOTE, "discovered", "2026-10-07"],
      ["remove-property", "Knowledge", "discovered"],
    ]) {
      const result = await cli(root, argv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("only `llmos discover` sets it");
    }
    expect(snapshot(root)).toEqual(before);
    const digest = await cli(root, ["set-property", REVIEWS_NOTE, "digested", TODAY]);
    expect(digest.exitCode).toBe(1);
    expect(digest.stderr).toContain("only `llmos daily activity` sets it");
    const other = await cli(root, ["set-property", KNOWLEDGE_NOTE, "status", "active"]);
    expect(other.exitCode).toBe(0);
  });

  test("a plain vault has no manual jobs", async () => {
    const result = await cli(cleanVault(null), ["health", "--json", "--vault", "notebook"]);
    expect(JSON.parse(result.stdout).overdue_jobs).toEqual([]);
  });
});

/** A vault with a 4-note uncovered cluster, a 3-note covered one, and decoys. */
function clusterVault(withKnowledgeNote = true): string {
  const files: Record<string, string> = {
    "projects/a/notes.md": note("https://arxiv.org/abs/2403.11111v2 and 10.1234/abc"),
    "projects/b/notes.md": note("arXiv:2403.11111 and doi:10.1234/ABC."),
    "raw/c.md": note("https://arxiv.org/pdf/2403.11111.pdf and 10.1234/abc"),
    "projects/d/notes.md": note("bare 2403.11111 and (10.1234/abc)"),
    "knowledge/hub.md": note("The hub."),
    // The covered cluster shares four keys, so it scores higher than the first one.
    "projects/e/notes.md": note("10.5555/q 10.5555/r 10.5555/s [[missing-one]] [[hub]]"),
    "projects/f/notes.md": note("10.5555/q 10.5555/r 10.5555/s [[missing-one]] [[hub]]"),
    "projects/g/notes.md": note(
      "10.5555/q 10.5555/r 10.5555/s [[missing-one]]",
      'topics:\n  - "[[hub]]"\n',
    ),
    // Two notes with two shared keys, and a lone shared key: no cluster.
    "projects/p/notes.md": note("10.7777/a 10.7777/b"),
    "projects/q/notes.md": note("10.7777/a 10.7777/b"),
  };
  if (withKnowledgeNote) files[KNOWLEDGE_NOTE] = note("# Knowledge hub");
  for (let i = 0; i < 5; i++) files[`projects/filler${i}/notes.md`] = note(`10.8888/own${i}`);
  return makeVault(files);
}

function reports(env: Record<string, string>, root: string, extra: string[] = []) {
  const out = join(scratch("out"), "reports");
  return cli(root, ["discover", "--out", out, ...extra], { env }).then((result) => ({
    result,
    out,
  }));
}

describe("discover", () => {
  test("ranks the uncovered cluster first, then the covered one, and writes the report outside the vault", async () => {
    const root = clusterVault();
    const env = isolatedEnv();

    const { result, out } = await reports(env, root, ["--no-record"]);

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.clusters.map((c: { notes: string[] }) => c.notes)).toEqual([
      ["projects/a/notes.md", "projects/b/notes.md", "projects/d/notes.md", "raw/c.md"],
      ["projects/e/notes.md", "projects/f/notes.md", "projects/g/notes.md"],
    ]);
    const [first, second] = report.clusters;
    expect([first.rank, first.covered_by]).toEqual([1, null]);
    expect([second.rank, second.covered_by]).toEqual([2, "knowledge/hub.md"]);
    expect(second.score).toBeGreaterThan(first.score);
    expect(first.signals.shared_ids.map((s: { id: string }) => s.id)).toEqual([
      "arxiv:2403.11111",
      "doi:10.1234/abc",
    ]);
    expect(second.signals.shared_dangling).toBe(1);
    expect(result.stdout).not.toContain("missing-one");
    expect(report.qmd_notice).toContain("no qmd index");
    expect(report.report_path).toBe(join(out, `${TODAY}.json`));
    expect(JSON.parse(readFileSync(report.report_path, "utf8"))).toEqual(report);
  });

  test("--top limits the clusters", async () => {
    const { result } = await reports(isolatedEnv(), clusterVault(), ["--top", "1"]);
    expect(JSON.parse(result.stdout).clusters).toHaveLength(1);
  });

  describe("the default folder", () => {
    test("is discover/ inside the artifacts link of the real vault root", async () => {
      const root = clusterVault();
      const target = scratch("artifacts-target");
      symlinkSync(target, join(root, "artifacts"));
      const alias = join(scratch("alias"), "vault");
      symlinkSync(root, alias);

      const result = await cli(alias, ["discover", "--no-record"], { env: isolatedEnv() });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(target, "discover", `${TODAY}.json`))).toBe(true);
    });

    test("fails naming the artifacts link when it is missing", async () => {
      const root = clusterVault();

      const result = await cli(root, ["discover", "--no-record"], { env: isolatedEnv() });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        `no artifacts folder at ${join(realpathSync(root), "artifacts")}`,
      );
      expect(existsSync(join(root, "..", "artifacts"))).toBe(false);
    });

    test("is refused when artifacts is a real folder inside the vault", async () => {
      const root = clusterVault();
      mkdirSync(join(root, "artifacts"));

      const result = await cli(root, ["discover", "--no-record"], { env: isolatedEnv() });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("never writes inside the vault");
      expect(existsSync(join(root, "artifacts", "discover"))).toBe(false);
    });
  });

  test("it refuses an --out inside the vault", async () => {
    const root = clusterVault();
    const result = await cli(root, ["discover", "--out", join(root, "notes")], {
      env: isolatedEnv(),
    });
    expect(result.exitCode).toBe(2);
    expect(existsSync(join(root, "notes"))).toBe(false);
  });

  test("a link planted at the report path does not carry the write into the vault", async () => {
    const root = clusterVault();
    const out = join(scratch("out"), "reports");
    mkdirSync(out);
    const planted = join(root, "planted.md");
    symlinkSync(planted, join(out, `${TODAY}.json`));

    const result = await cli(root, ["discover", "--out", out, "--no-record"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(planted)).toBe(false);
    expect(lstatSync(join(out, `${TODAY}.json`)).isSymbolicLink()).toBe(false);
  });

  test("a run sets discovered on the Knowledge note, stamps it, and changes nothing else", async () => {
    const root = clusterVault();
    const before = snapshot(root);
    const { result } = await reports(isolatedEnv(), root);

    expect(result.exitCode).toBe(0);
    expect(changed(before, snapshot(root))).toEqual([KNOWLEDGE_NOTE]);
    const properties = VaultModel.load(root).resolveNote(KNOWLEDGE_NOTE).properties;
    expect(properties.discovered).toBe(TODAY);
    expect(properties.updated).toBe(TODAY);
    expect(properties.created).toBe("2026-10-01");
    const health = await cli(root, ["health", "--json"]);
    const overdue = JSON.parse(health.stdout).overdue_jobs as { job: string }[];
    expect(overdue.map((job) => job.job)).not.toContain("discover");
  });

  test("--no-record, a failed run, and a plain vault leave the vault as it was", async () => {
    const root = clusterVault();
    const before = snapshot(root);
    const env = isolatedEnv();

    expect((await reports(env, root, ["--no-record"])).result.exitCode).toBe(0);
    expect((await reports(env, root, ["--vault", "notebook"])).result.exitCode).toBe(0);
    const blocker = join(scratch("blocker"), "file");
    writeFiles(join(blocker, ".."), { file: "x" });
    const failed = await cli(root, ["discover", "--out", join(blocker, "sub")], { env });
    expect(failed.exitCode).toBe(1);

    expect(snapshot(root)).toEqual(before);
  });

  test.each([
    ["has unreadable frontmatter", { [KNOWLEDGE_NOTE]: "---\nz: &x one\na: *x\n---\n\n# K\n" }],
    ["is a symbolic link", "link"],
  ] as const)("it fails before any work when the Knowledge note %s", async (_name, setup) => {
    const root = clusterVault(false);
    if (typeof setup === "object") writeFiles(root, setup);
    else {
      // The link points inside the vault, where the write guard alone would allow it.
      writeFiles(root, { "projects/hub-copy.md": note("# Knowledge hub") });
      mkdirSync(join(root, "categories"), { recursive: true });
      symlinkSync(join(root, "projects/hub-copy.md"), join(root, KNOWLEDGE_NOTE));
    }
    const before = snapshot(root);
    const { result, out } = await reports(isolatedEnv(), root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Knowledge\.md/);
    expect(existsSync(out)).toBe(false);
    expect(snapshot(root)).toEqual(before);
    expect((await reports(isolatedEnv(), root, ["--no-record"])).result.exitCode).toBe(0);
  });

  test("without the Knowledge note it fails before any work, unless it is a probe", async () => {
    const root = clusterVault(false);
    const env = isolatedEnv();
    const { result, out } = await reports(env, root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(KNOWLEDGE_NOTE);
    expect(existsSync(out)).toBe(false);

    expect((await reports(env, root, ["--no-record"])).result.exitCode).toBe(0);
  });
});
