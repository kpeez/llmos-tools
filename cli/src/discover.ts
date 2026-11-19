/**
 * `llmos discover`: rank clusters of notes that restate the same works,
 * as candidates for `consolidate-knowledge`.
 *
 * The algorithm, in short:
 *
 * 1. Candidate notes are every note outside `knowledge/`, `daily/`, and
 *    `categories/`, except the rule notes at the vault root and the captured
 *    sources (`raw/<slug>/source.md`). The inbox drops in `raw/` stay: they
 *    are raw material. Notes in `knowledge/` only mark coverage.
 * 2. Each candidate holds keys: the arXiv ids and DOIs in its text
 *    (`extractIds`), the wikilink targets that resolve to no note and name no
 *    file (dangling; `![[Reviews.base#Project]]` is none), and the `topics` whose topic note does not exist.
 * 3. A key shared by two or more candidates links each pair of them with the
 *    weight ln(N / df): N candidates, df the notes that hold the key. A key
 *    held by more than `MAX_KEY_NOTES` notes is too generic and is ignored.
 *    A pair that is also a mutual top-`SIMILAR_NEIGHBORS` neighbor pair by
 *    qmd's stored vectors (`similarPairs`) adds its cosine to the weight.
 * 4. An edge counts when its notes share `MIN_SHARED_KEYS` keys, or one key
 *    and a similar pair, and when the shared keys are at least `MIN_OVERLAP`
 *    of the two notes' keys, weighted by idf (so a note that cites dozens of
 *    works does not bridge unrelated clusters). Clusters are the connected components of the
 *    counted edges with `MIN_CLUSTER_NOTES` notes or more. A cluster's score
 *    is the sum of its counted edge weights.
 * 5. A cluster is covered by the `knowledge/` note that at least half of its
 *    notes link (by wikilink or `topics`; the most linked one). Uncovered
 *    clusters rank first, by score; covered ones follow, by score.
 *
 * The arXiv patterns are looser than the anchored ones in `sources.ts`
 * because they search free text; both read only new-style ids.
 */

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { UsageError } from "./cli.ts";
import { DISCOVER_NOTE, DISCOVER_PROPERTY } from "./health.ts";
import {
  AUTHORING_NOTE,
  DAILY_DIR,
  INGEST_CONTRACT_NOTE,
  isInboxDrop,
  RAW_DIR,
  SCHEMA_NOTE,
} from "./layout.ts";
import { documentVectors, openQmd, qmdLocation } from "./qmd.ts";
import { extractWikilinks, type Note, type VaultModel } from "./vault.ts";
import { recordRun } from "./write.ts";

/** Folders whose notes are never candidates. */
export const EXCLUDED_FOLDERS = ["knowledge/", `${DAILY_DIR}/`, "categories/"];
/** The vault's own rules, at its root, are never candidates. */
const RULE_NOTES = new Set([SCHEMA_NOTE, AUTHORING_NOTE, INGEST_CONTRACT_NOTE]);
/** Whether a note is a candidate for clustering. In `raw/`, only inbox drops are. */
export function isCandidate(path: string): boolean {
  if (path.startsWith(`${RAW_DIR}/`)) return isInboxDrop(path);
  return !RULE_NOTES.has(path) && !EXCLUDED_FOLDERS.some((folder) => path.startsWith(folder));
}

/** A key held by more notes than this is too generic to link them. */
export const MAX_KEY_NOTES = 25;
/** Keys two notes must share for their edge to count, without a similar pair. */
export const MIN_SHARED_KEYS = 2;
/**
 * The weighted overlap (Jaccard by idf) an edge needs to count. Without it,
 * literature notes that cite dozens of works chain unrelated projects into
 * one component. Calibrated on the vault before the macaque consolidation
 * (#66): 0.20 kept 12 of its 13 member notes in a 16-note cluster at rank 1;
 * no overlap rule gave one 50-note cluster; 0.30 split the cluster apart.
 */
export const MIN_OVERLAP = 0.2;
/** The fewest notes in a reported cluster. */
export const MIN_CLUSTER_NOTES = 3;
/** The neighbors per note that count as similar (both notes must list each other). */
export const SIMILAR_NEIGHBORS = 5;

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Identifiers

const ARXIV_NEW = String.raw`(\d{2})(\d{2})\.(\d{4,5})`;
const ARXIV_PATTERNS = [
  // A URL, `arXiv:<id>`, and the `arxiv-<id>` slug of a captured source.
  new RegExp(String.raw`arxiv\.org/(?:abs|pdf|html)/${ARXIV_NEW}(?!\d)`, "gi"),
  new RegExp(String.raw`arxiv:\s*${ARXIV_NEW}(?!\d)`, "gi"),
  new RegExp(String.raw`arxiv-${ARXIV_NEW}(?!\d)`, "gi"),
  // A bare token: not the tail of a longer number, DOI, or path.
  new RegExp(String.raw`(?<![\w./-])${ARXIV_NEW}(?!\d)`, "g"),
];
// Crossref's recommended suffix characters; anything else ends the DOI.
const DOI = /(?<![\w.])10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g;
const UNDATED_SUFFIX = /\.(?:full(?:\.pdf|-text)?|abstract|supplementary-material)$/;
// A publisher page after a DOI; the DOI itself must keep a suffix.
const PUBLISHER_PAGE = /^(10\.\d+\/.+)\/(?:full|abstract|pdf|epdf)$/;
const BIORXIV_DATED = /^10\.1101\/(\d{4}\.\d{2}\.\d{2}\.\d+)/;
const ARXIV_DOI = /^10\.48550\/arxiv\.(\d{2})(\d{2})\.(\d{4,5})(?:v\d+)?$/;

/**
 * `arxiv:YYMM.NNNN[N]` when the parts make a real id, else null: the month is
 * 01-12; a 4-digit number needs 0704 <= YYMM <= 1412 (new-style ids start in
 * 2007-04); a 5-digit number needs 1501 <= YYMM and a year not after `year`.
 */
function arxivId(yy: string, mm: string, number: string, year: number): string | null {
  const month = Number(mm);
  const yymm = Number(yy + mm);
  if (month < 1 || month > 12) return null;
  const valid =
    number.length === 4 ? yymm >= 704 && yymm <= 1412 : yymm >= 1501 && Number(yy) <= year % 100;
  return valid ? `arxiv:${yy}${mm}.${number}` : null;
}

/** A DOI without the punctuation of the sentence or Markdown around it, and an unbalanced `)`. */
function trimDoi(doi: string): string {
  let end = doi.length;
  for (; end > 0; end--) {
    const last = doi[end - 1] as string;
    const head = doi.slice(0, end);
    const unbalanced = last === ")" && head.split(")").length > head.split("(").length;
    if (!("._,;:/".includes(last) || unbalanced)) break;
  }
  return doi.slice(0, end);
}

/**
 * The arXiv ids and DOIs in `text`, as `arxiv:<id>` and `doi:<doi>`, without
 * duplicates. An arXiv id is new-style (see `arxivId`), so `2020.10141` and
 * `1203.12345` are no ids; its version is dropped. `now` (default: today)
 * bounds the year of a 5-digit id. A DOI is lower-case, ends at the first
 * character outside Crossref's suffix set, and loses trailing punctuation;
 * the DOI of an arXiv paper (`10.48550/arXiv.<id>`) reads as that id. A
 * bioRxiv or medRxiv DOI with the dated form (`10.1101/2024.03.12.123456`)
 * keys on exactly that; another one loses its `.full`, `.abstract`, or
 * `.supplementary-material` suffix and its version. The URL escapes of
 * `/ ( ) : ; < >` are decoded first. A DOI loses a trailing `/full`, `/abstract`,
 * `/pdf`, or `/epdf` (publisher page URLs), and is dropped when `<` or `>`
 * follows it: such DOIs (SICI, AMS) would otherwise shorten to a key that
 * unrelated papers share. `<https://doi.org/...>` is no such case. Text inside
 * a wikilink never joins a DOI: it may hold a name that must stay in the vault.
 */
export function extractIds(text: string, now: Date = new Date()): string[] {
  const year = now.getFullYear();
  const found = new Set<string>();
  for (const pattern of ARXIV_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const id = arxivId(match[1] as string, match[2] as string, match[3] as string, year);
      if (id !== null) found.add(id);
    }
  }
  const doiText = text
    .replace(/%(?:2f|28|29|3a|3b|3c|3e)/gi, (code) => decodeURIComponent(code))
    .replace(/\[\[[^\]\n]*\]\]/g, " ");
  for (const match of doiText.matchAll(DOI)) {
    const next = doiText[match.index + match[0].length];
    const token = doiText.slice(doiText.slice(0, match.index).search(/\S*$/), match.index);
    if (next === "<" || (next === ">" && !token.includes("<"))) continue;
    const doi = trimDoi(match[0]).toLowerCase().replace(PUBLISHER_PAGE, "$1");
    const arxiv = ARXIV_DOI.exec(doi);
    const id = arxiv && arxivId(arxiv[1] as string, arxiv[2] as string, arxiv[3] as string, year);
    const dated = BIORXIV_DATED.exec(doi);
    if (id) found.add(id);
    else if (dated) found.add(`doi:10.1101/${dated[1]}`);
    else if (doi.startsWith("10.1101/")) {
      found.add(`doi:${doi.replace(UNDATED_SUFFIX, "").replace(/v\d+$/, "")}`);
    } else found.add(`doi:${doi}`);
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// The pure core

export interface SimilarPair {
  a: string;
  b: string;
  cosine: number;
}

export interface Cluster {
  rank: number;
  score: number;
  /** Vault-relative paths, in path order. */
  notes: string[];
  /** The `knowledge/` note that at least half of the notes link; null when none. */
  covered_by: string | null;
  /**
   * Dangling targets and missing topics are counts, not labels: the report
   * lives outside the vault, and a link target can be a value that must stay
   * in it (a project's private identifiers). arXiv ids and DOIs are public.
   */
  signals: {
    shared_ids: { id: string; notes: string[] }[];
    shared_dangling: number;
    shared_topics: number;
    similar_pairs: number;
  };
}

type KeyKind = "id" | "dangling" | "topic";

interface NoteKeys {
  keys: { kind: KeyKind; label: string }[];
  /** `knowledge/` notes this note links, by wikilink or `topics`. */
  knowledge: Set<string>;
}

function topicLabels(note: Note): string[] {
  const topics = note.properties.topics;
  const items = Array.isArray(topics) ? topics : [topics];
  const labels = items
    .filter((topic): topic is string => typeof topic === "string")
    .map((topic) => (extractWikilinks(topic)[0] ?? topic).trim())
    .filter((label) => label !== "");
  return [...new Set(labels)];
}

function noteKeys(model: VaultModel, note: Note): NoteKeys {
  const keys: NoteKeys["keys"] = extractIds(note.text).map((label) => ({ kind: "id", label }));
  const knowledge = new Set<string>();
  const seen = new Set<string>();
  const add = (kind: KeyKind, label: string): void => {
    const target = model.resolveLink(label, note);
    if (target === undefined) {
      // An embed of a Base or an image names a file that exists: no dangling link.
      if (model.isFile(label)) return;
      const lower = label.toLowerCase();
      if (!seen.has(`${kind}:${lower}`)) keys.push({ kind, label: lower });
      seen.add(`${kind}:${lower}`);
    } else if (target.path.startsWith("knowledge/")) knowledge.add(target.path);
  };
  const topics = topicLabels(note);
  for (const topic of topics) add("topic", topic);
  const topicSet = new Set(topics.map((topic) => topic.toLowerCase()));
  // A missing topic note is one signal (the topic), not also a dangling link.
  for (const target of note.targets) {
    if (!topicSet.has(target.toLowerCase())) add("dangling", target);
  }
  return { keys, knowledge };
}

function pairId(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The ranked clusters of a vault (see the module comment), with `similar`
 * pairs from the vector signal when qmd has them. Rank 1 is the best.
 */
export function findClusters(model: VaultModel, similar: readonly SimilarPair[] = []): Cluster[] {
  const candidates = model.notes.filter((note) => isCandidate(note.path));
  const index = new Map(candidates.map((note, i) => [note.path, i]));
  const perNote = candidates.map((note) => noteKeys(model, note));

  const holders = new Map<string, { kind: KeyKind; label: string; notes: number[] }>();
  perNote.forEach(({ keys }, i) => {
    for (const { kind, label } of keys) {
      const id = `${kind}\0${label}`;
      const holder = holders.get(id);
      if (holder) holder.notes.push(i);
      else holders.set(id, { kind, label, notes: [i] });
    }
  });
  const usable = [...holders.values()].filter(
    (holder) => holder.notes.length >= 2 && holder.notes.length <= MAX_KEY_NOTES,
  );

  const similarity = new Map<string, number>();
  for (const { a, b, cosine } of similar) {
    const [i, j] = [index.get(a), index.get(b)];
    if (i !== undefined && j !== undefined && i !== j) similarity.set(pairId(i, j), cosine);
  }

  const edges = new Map<string, { a: number; b: number; shared: number; weight: number }>();
  for (const holder of usable) {
    const idf = Math.log(candidates.length / holder.notes.length);
    for (const [x, a] of holder.notes.entries()) {
      for (const b of holder.notes.slice(x + 1)) {
        const id = pairId(a, b);
        const edge = edges.get(id) ?? { a, b, shared: 0, weight: 0 };
        edge.shared++;
        edge.weight += idf;
        edges.set(id, edge);
      }
    }
  }

  // Connected components of the counted edges.
  const parent = candidates.map((_, i) => i);
  const root = (i: number): number => {
    let at = i;
    while (parent[at] !== at) at = parent[at] as number;
    return at;
  };
  // A note's key mass: the idf sum of its usable keys, for the weighted overlap.
  const mass = candidates.map(() => 0);
  for (const holder of usable) {
    const idf = Math.log(candidates.length / holder.notes.length);
    for (const i of holder.notes) mass[i] = (mass[i] as number) + idf;
  }
  const counted: { a: number; b: number; weight: number }[] = [];
  for (const [id, edge] of edges) {
    const cosine = similarity.get(id);
    if (edge.shared < MIN_SHARED_KEYS && cosine === undefined) continue;
    const union = (mass[edge.a] as number) + (mass[edge.b] as number) - edge.weight;
    if (union <= 0 || edge.weight / union < MIN_OVERLAP) continue;
    counted.push({ a: edge.a, b: edge.b, weight: edge.weight + (cosine ?? 0) });
    parent[root(edge.a)] = root(edge.b);
  }
  const components = new Map<number, number[]>();
  candidates.forEach((_, i) => {
    const group = components.get(root(i));
    if (group) group.push(i);
    else components.set(root(i), [i]);
  });

  const clusters: Omit<Cluster, "rank">[] = [];
  for (const members of components.values()) {
    if (members.length < MIN_CLUSTER_NOTES) continue;
    const inside = new Set(members);
    const names = (notes: number[]): string[] =>
      notes.map((i) => (candidates[i] as Note).path).sort();
    const shared = (kind: KeyKind): { label: string; notes: string[] }[] =>
      usable
        .filter((holder) => holder.kind === kind)
        .map((holder) => ({
          label: holder.label,
          notes: names(holder.notes.filter((i) => inside.has(i))),
        }))
        .filter((signal) => signal.notes.length >= 2)
        .sort((x, y) => y.notes.length - x.notes.length || (x.label < y.label ? -1 : 1));
    const linked = new Map<string, number>();
    for (const i of members) {
      for (const path of (perNote[i] as NoteKeys).knowledge) {
        linked.set(path, (linked.get(path) ?? 0) + 1);
      }
    }
    const [best] = [...linked].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    clusters.push({
      score: round(
        counted.filter((e) => inside.has(e.a) && inside.has(e.b)).reduce((s, e) => s + e.weight, 0),
      ),
      notes: names(members),
      covered_by: best && best[1] * 2 >= members.length ? best[0] : null,
      signals: {
        shared_ids: shared("id").map((s) => ({ id: s.label, notes: s.notes })),
        shared_dangling: shared("dangling").length,
        shared_topics: shared("topic").length,
        similar_pairs: [...similarity.keys()].filter((id) => {
          const [a, b] = id.split(",").map(Number) as [number, number];
          return inside.has(a) && inside.has(b);
        }).length,
      },
    });
  }
  clusters.sort(
    (x, y) =>
      Number(x.covered_by !== null) - Number(y.covered_by !== null) ||
      y.score - x.score ||
      (x.notes[0] as string).localeCompare(y.notes[0] as string),
  );
  return clusters.map((cluster, i) => ({ rank: i + 1, ...cluster }));
}

/**
 * The mutual nearest neighbors among `paths`: the pairs where each note is
 * among the other's `neighbors` most similar notes. Vectors have length 1,
 * so the dot product is the cosine. A path without a vector is skipped.
 */
export function similarPairs(
  vectors: ReadonlyMap<string, Float32Array>,
  paths: readonly string[],
  neighbors = SIMILAR_NEIGHBORS,
): SimilarPair[] {
  const held = paths.filter((path) => vectors.has(path));
  const top = held.map((path, i) => {
    const vector = vectors.get(path) as Float32Array;
    const scored: { j: number; cosine: number }[] = [];
    for (const [j, other] of held.entries()) {
      if (j === i) continue;
      const peer = vectors.get(other) as Float32Array;
      let dot = 0;
      for (let k = 0; k < vector.length; k++) dot += (vector[k] as number) * (peer[k] as number);
      scored.push({ j, cosine: dot });
    }
    return new Map(
      scored
        .sort((x, y) => y.cosine - x.cosine)
        .slice(0, neighbors)
        .map(({ j, cosine }) => [j, cosine]),
    );
  });
  const pairs: SimilarPair[] = [];
  top.forEach((mine, i) => {
    for (const [j, cosine] of mine) {
      if (j > i && top[j]?.has(i)) {
        pairs.push({ a: held[i] as string, b: held[j] as string, cosine: round(cosine) });
      }
    }
  });
  return pairs;
}

// ---------------------------------------------------------------------------
// The command's work

/** `path` with the real path of its nearest existing folder, so a link cannot hide a target. */
function realPath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

/**
 * The folder for the report. With `out` it is that folder; without it, the
 * `discover/` folder of the checkout's `artifacts/` (beside the vault root).
 * It must not lie inside the vault.
 */
export function reportFolder(root: string, out: string | undefined): string {
  let folder: string;
  if (out === undefined) {
    const artifacts = join(realpathSync(root), "..", "artifacts");
    if (!existsSync(artifacts)) {
      throw new UsageError(
        `no artifacts folder at ${resolve(artifacts)}; create the artifacts symlink (the repository's AGENTS.md describes it) or pass --out DIR`,
      );
    }
    folder = join(artifacts, "discover");
  } else folder = out;
  const where = relative(realpathSync(root), realPath(folder));
  const outside = where === ".." || where.startsWith("../") || isAbsolute(where);
  if (!outside) {
    throw new UsageError(`discover never writes inside the vault; ${folder} is inside ${root}`);
  }
  return folder;
}

/** Similar pairs among `paths` from the stored vectors of `collection`, or a notice why not. */
async function qmdSimilarity(
  env: Env,
  collection: string,
  paths: readonly string[],
): Promise<{ pairs: SimilarPair[]; notice: string | null }> {
  const location = qmdLocation(env);
  const skipped = (why: string) => ({ pairs: [], notice: `qmd similarity skipped: ${why}` });
  // Never create an index just to read it.
  if (!existsSync(location.dbPath)) return skipped(`no qmd index at ${location.dbPath}`);
  try {
    const store = await openQmd(location, false);
    try {
      const vectors = await documentVectors(store, collection);
      if (vectors === null) return skipped(`collection '${collection}' not found`);
      return { pairs: similarPairs(vectors, paths), notice: null };
    } finally {
      await store.close();
    }
  } catch (error) {
    return skipped(error instanceof Error ? error.message : String(error));
  }
}

export interface DiscoverReport {
  generated_at: string;
  vault: string;
  report_path: string;
  qmd_notice: string | null;
  clusters: Cluster[];
}

/**
 * Throw unless the run can be recorded on `DISCOVER_NOTE`: a real note of the
 * vault (not a link) whose frontmatter takes the edit `recordRun` will make.
 */
function checkRecordNote(model: VaultModel, today: string): void {
  const probe = " (use --no-record for a probe)";
  if (!model.notes.some((note) => note.path === DISCOVER_NOTE)) {
    throw new Error(
      `${DISCOVER_NOTE} not found in ${model.root}; discover records its run there${probe}`,
    );
  }
  try {
    model.read(DISCOVER_NOTE, { strict: true });
    recordRun(model.root, DISCOVER_NOTE, DISCOVER_PROPERTY, today, true);
  } catch (error) {
    throw new Error(
      `${DISCOVER_NOTE} cannot be rewritten, so discover cannot record its run there: ${(error as Error).message}${probe}`,
    );
  }
  const file = join(model.root, DISCOVER_NOTE);
  if (realpathSync(file) !== join(realpathSync(model.root), DISCOVER_NOTE)) {
    throw new Error(
      `${DISCOVER_NOTE} is a symbolic link or lies behind one; discover records its run only in a real note${probe}`,
    );
  }
}

/**
 * Rank the clusters of `model`, write the report to
 * `<folder>/<today>.json`, and return it. With `record`, it then sets the
 * `discovered` date on `DISCOVER_NOTE` (the run record `health` reads) and
 * `updated` in one write (`recordRun`); the vault changes nowhere else.
 * Throws before any work when the folder is refused or, with `record`, when that edit would
 * fail: the note is missing, is (or lies behind) a symbolic link, or has
 * frontmatter that cannot be rewritten.
 */
export async function discover(
  model: VaultModel,
  options: {
    vault: string;
    top: number;
    out: string | undefined;
    collection: string;
    env: Env;
    today: string;
    record: boolean;
  },
): Promise<DiscoverReport> {
  const folder = reportFolder(model.root, options.out);
  if (options.record) checkRecordNote(model, options.today);
  const candidates = model.notes.map((note) => note.path).filter(isCandidate);
  const { pairs, notice } = await qmdSimilarity(options.env, options.collection, candidates);
  const report: DiscoverReport = {
    generated_at: new Date().toISOString(),
    vault: options.vault,
    report_path: resolve(folder, `${options.today}.json`),
    qmd_notice: notice,
    clusters: findClusters(model, pairs).slice(0, options.top),
  };
  mkdirSync(folder, { recursive: true });
  // A link planted at the report path must not carry the write elsewhere.
  rmSync(report.report_path, { force: true });
  writeFileSync(report.report_path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  if (options.record) {
    recordRun(model.root, DISCOVER_NOTE, DISCOVER_PROPERTY, options.today);
  }
  return report;
}
