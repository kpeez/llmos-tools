/**
 * Differential harness: run the frozen Python CLI and the TypeScript core on
 * the same vaults and compare every result.
 *
 * Usage, from `tools/`:
 *   bun test/differential/run.ts [--edge-vault] [--depth2-every N]
 *     [--report FILE] [--today YYYY-MM-DD] [VAULT ...]
 *
 * For each vault it compares the JSON each CLI prints and its exit code for
 * `list` and `daily recent --n 2`; for every note `read`, `neighbors`,
 * `subgraph` at depth 1, and `check`; `subgraph` at depth 2 for every Nth
 * note (all notes by default); `read` by every note name; and `health
 * --json` (qmd unavailable on both sides). JSON compares by value, so key
 * order is not compared: it is not part of the contract. It also compares
 * `normalize` and the schema audit, which have no CLI JSON form. Absolute
 * paths become vault-relative before comparison.
 *
 * Python reads a note whose frontmatter it refuses as having no properties,
 * and TypeScript reads valid YAML that Python refuses (and an empty `---`
 * `---` block, which Python does not see as a block). So the harness runs
 * the TypeScript side twice: once with exactly those notes read as Python
 * reads them ("compatible"), and once as it really reads them ("full").
 * Python must match the compatible run except for allowlisted `normalize`
 * results; every difference between the compatible and full runs follows
 * from the properties Python cannot read. The harness also checks, for every
 * note TypeScript normalizes, that the output keeps the note's values and
 * does not change when normalized again.
 *
 * `--edge-vault` adds a generated vault of resolver and frontmatter edge
 * cases. The run exits 1 when any difference is not in the allowlist.
 * Never point it at the live vault: copy the vault outside `llmOS/` first.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { isMap, isNode, isScalar, isSeq, parseDocument, Scalar, visit } from "yaml";
import { realpath } from "../../src/authoring.ts";
import { localDate } from "../../src/cli.ts";
import { parseDay } from "../../src/daily.ts";
import { normalize, parse, UnsupportedFrontmatter } from "../../src/frontmatter.ts";
import { type NoteSource, VaultModel } from "../../src/vault.ts";
import { ALLOWLIST, type Comparison, type Difference } from "./allowlist.ts";
import { writeEdgeVault } from "./edge_vault.ts";
import { type OracleResults, typescriptResults } from "./typescript_oracle.ts";

const TOOLS = resolve(dirname(import.meta.path), "../..");

// Text that bare YAML 1.1 or 1.2 reads as a null, bool, or number.
const TYPED_LOOKING =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|[-+]?[0-9][0-9_]*|[-+]?0o[0-7_]+|[-+]?0x[0-9a-fA-F_]+|[-+]?0b[01_]+|[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+(\.[0-9_]*)?|[-+]?(\.[0-9_]+|[0-9][0-9_]*(\.[0-9_]*)?)([eE][-+]?[0-9]+)?|[-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN))$/;

/** Replace the vault root in every string with `<vault>`, so the two sides compare. */
function relativize(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.replaceAll(root, "<vault>");
  if (Array.isArray(value)) return value.map((item) => relativize(item, root));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, relativize(item, root)]),
    );
  }
  return value;
}

/**
 * The YAML features of a note's frontmatter block that the Python line
 * parser refuses, so each allowlisted `normalize` difference names its cause.
 */
function yamlFeatures(text: string): string[] {
  if (text.startsWith("---\n---\n")) return ["empty-block"];
  const end = text.indexOf("\n---\n", 4);
  if (!text.startsWith("---\n") || end === -1) return [];
  const source = `${text.slice(4, end)}\n`;
  const doc = parseDocument(source, { schema: "failsafe" });
  const features = new Set<string>();
  if (source.includes("\t")) features.add("tab");
  // Python reads list items only as `  - item`.
  if (/^(?! {2}- )[ ]*-( |$)/m.test(source)) features.add("list-indent");
  if (doc.commentBefore || doc.comment) features.add("comment");
  visit(doc, (key, node, path) => {
    if (!isNode(node)) return;
    if (node.commentBefore || node.comment) features.add("comment");
    if (node.anchor) features.add("anchor-or-alias");
    if (node.tag) features.add("tag");
    if (isScalar(node)) {
      const raw = node.range ? source.slice(node.range[0], node.range[1]) : "";
      if (node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED) {
        features.add("block-scalar");
        return;
      }
      if (raw.includes("\n")) features.add("multi-line-scalar");
      if (node.type === Scalar.QUOTE_DOUBLE && /\\[^\\"]/.test(raw.replaceAll("\\\\", ""))) {
        features.add("escape-sequence");
      }
      const quoted = node.type === Scalar.QUOTE_DOUBLE || node.type === Scalar.QUOTE_SINGLE;
      const value = String(node.value);
      if (key === "key" && quoted) features.add("quoted-key");
      if (key === "value" && quoted && (value === "" || TYPED_LOOKING.test(value))) {
        features.add("quoted-typed-scalar");
      }
    } else if (isMap(node) || isSeq(node)) {
      const parents = path.filter((step) => isMap(step) || isSeq(step));
      const nestedMap = isMap(node) && parents.length > 0;
      const listInList = isSeq(node) && parents.some((step) => isSeq(step));
      if (nestedMap || listInList) features.add("nested-collection");
    } else {
      features.add("anchor-or-alias");
    }
  });
  return [...features].sort();
}

/**
 * A note as the Python reader sees it, given Python's normalize error for it:
 * no block means no properties and the whole text as body; a refused block
 * means no properties and the text after Python's closing `---` as body.
 */
function pythonReading(
  note: NoteSource,
  error: { error: string; message: string } | undefined,
): NoteSource {
  if (error?.error === "MissingFrontmatter") {
    return {
      path: note.path,
      text: note.text,
      properties: {},
      body: note.text,
      hasFrontmatter: false,
    };
  }
  if (error?.error === "UnsupportedFrontmatter") {
    const end = note.text.indexOf("\n---\n", 4);
    return {
      path: note.path,
      text: note.text,
      properties: {},
      body: note.text.slice(end + 5).replace(/^\n+/, ""),
      hasFrontmatter: true,
      frontmatterError: new UnsupportedFrontmatter(error.message),
    };
  }
  return note;
}

function runPython(root: string, day: string, depth2: string[], output: string): OracleResults {
  const command = [
    "uv",
    "run",
    "--quiet",
    "python",
    "test/differential/python_oracle.py",
    root,
    "--today",
    day,
    "--output",
    output,
    "--subgraph-depth2",
    ...depth2,
  ];
  const result = Bun.spawnSync(command, { cwd: TOOLS, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`python oracle failed with exit ${result.exitCode}`);
  return JSON.parse(readFileSync(output, "utf8")) as OracleResults;
}

function compareResults(
  vault: string,
  comparison: Comparison,
  left: OracleResults,
  right: OracleResults,
): { compared: number; differences: Difference[] } {
  const differences: Difference[] = [];
  let compared = 0;
  const check = (section: string, key: string, a: unknown, b: unknown): void => {
    compared++;
    if (!isDeepStrictEqual(a, b)) {
      differences.push({ vault, comparison, section, key, python: a, typescript: b });
    }
  };

  if (!Array.isArray(left.list) || !Array.isArray(right.list)) {
    check("list", "", left.list, right.list);
  }
  const listLength = Math.max(
    Array.isArray(left.list) ? left.list.length : 0,
    Array.isArray(right.list) ? right.list.length : 0,
  );
  for (let i = 0; i < listLength; i++) {
    const entry = (left.list[i] ?? right.list[i]) as { path?: string } | undefined;
    check("list", entry?.path ?? String(i), left.list[i], right.list[i]);
  }

  const paths = new Set([...Object.keys(left.notes), ...Object.keys(right.notes)]);
  for (const path of [...paths].sort()) {
    const a = left.notes[path];
    const b = right.notes[path];
    if (a === undefined || b === undefined) {
      check("note-set", path, a !== undefined, b !== undefined);
      continue;
    }
    for (const section of new Set([...Object.keys(a), ...Object.keys(b)])) {
      check(section, path, a[section], b[section]);
    }
  }

  const names = new Set([...Object.keys(left.by_name), ...Object.keys(right.by_name)]);
  for (const name of [...names].sort()) {
    check("by_name", name, left.by_name[name], right.by_name[name]);
  }

  // Python visits the schema's link fields in set order, which varies from
  // run to run, so the audit messages compare as sorted lists.
  const bySchemaOrder = (value: unknown, field: string): unknown =>
    field === "schema_violations" && Array.isArray(value)
      ? [...value].sort((a, b) => {
          const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
          return x < y ? -1 : x > y ? 1 : 0;
        })
      : value;
  const leftHealth = left.health as Record<string, unknown>;
  const rightHealth = right.health as Record<string, unknown>;
  for (const field of new Set([...Object.keys(leftHealth), ...Object.keys(rightHealth)])) {
    check(
      `health.${field}`,
      "",
      bySchemaOrder(leftHealth[field], field),
      bySchemaOrder(rightHealth[field], field),
    );
  }

  check("daily_recent", "", left.daily_recent, right.daily_recent);
  check("schema.errors", "", [...left.schema.errors].sort(), [...right.schema.errors].sort());
  check("schema.checked", "", left.schema.checked, right.schema.checked);
  return { compared, differences };
}

/** Normalizing must keep every value and must be idempotent. */
function invariantDifferences(vault: string, model: VaultModel): Difference[] {
  const differences: Difference[] = [];
  for (const note of model.notes) {
    let once: string;
    try {
      once = normalize(note.text);
    } catch {
      continue;
    }
    const twice = (() => {
      try {
        return normalize(once);
      } catch (error) {
        return String(error);
      }
    })();
    const kept = isDeepStrictEqual(parse(once).properties, parse(note.text).properties);
    if (twice !== once || !kept) {
      differences.push({
        vault,
        comparison: "invariant",
        section: twice !== once ? "normalize-idempotent" : "normalize-keeps-values",
        key: note.path,
        python: once,
        typescript: twice,
      });
    }
  }
  return differences;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      "edge-vault": { type: "boolean", default: false },
      "depth2-every": { type: "string", default: "1" },
      report: { type: "string" },
      today: { type: "string", default: localDate() },
    },
  });
  const every = Number(values["depth2-every"]);
  const day = values.today as string;
  const dayNumber = parseDay(day);
  if (dayNumber === null || !Number.isInteger(every) || every < 1) {
    throw new Error("usage: --today YYYY-MM-DD and --depth2-every N (N >= 1)");
  }
  const scratch = mkdtempSync(join(tmpdir(), "llmos-differential-"));
  const vaults = positionals.map((path) => realpath(path));
  if (values["edge-vault"]) {
    const edge = join(scratch, "edge-vault");
    writeEdgeVault(edge);
    vaults.push(realpath(edge));
  }

  const report = [];
  let unexpected = 0;
  try {
    for (const [index, root] of vaults.entries()) {
      const loadStarted = performance.now();
      const full = VaultModel.load(root);
      const loadSeconds = (performance.now() - loadStarted) / 1000;
      const depth2 = full.notes.filter((_, i) => i % every === 0).map((note) => note.path);
      const depth2Set = new Set(depth2);

      const pythonStarted = performance.now();
      const python = relativize(
        runPython(root, day, depth2, join(scratch, `python-${index}.json`)),
        root,
      ) as OracleResults;
      const pythonSeconds = (performance.now() - pythonStarted) / 1000;

      // Read every note Python cannot parse the way Python reads it.
      const pythonErrors = new Map<string, { error: string; message: string }>();
      for (const [path, result] of Object.entries(python.notes)) {
        const normalized = result.normalize as { error?: string; message?: string };
        if (typeof normalized?.error === "string") {
          pythonErrors.set(path, { error: normalized.error, message: String(normalized.message) });
        }
      }
      const refused = [...pythonErrors]
        .filter(([, error]) => error.error === "UnsupportedFrontmatter")
        .map(([path]) => path);
      const compatible = VaultModel.fromSources(
        root,
        full.notes.map((note) => pythonReading(note, pythonErrors.get(note.path))),
        full.brokenLinks,
      );

      const typescriptStarted = performance.now();
      const fullResults = relativize(
        await typescriptResults(full, day, (path) => depth2Set.has(path)),
        full.root,
      ) as OracleResults;
      const typescriptSeconds = (performance.now() - typescriptStarted) / 1000;
      const compatibleResults = relativize(
        await typescriptResults(compatible, day, (path) => depth2Set.has(path)),
        compatible.root,
      ) as OracleResults;

      let slowestSubgraph = { path: "", seconds: 0 };
      for (const note of full.notes) {
        const started = performance.now();
        full.subgraph(note.path, 2);
        const seconds = (performance.now() - started) / 1000;
        if (seconds > slowestSubgraph.seconds) slowestSubgraph = { path: note.path, seconds };
      }

      const first = compareResults(root, "python-vs-compatible", python, compatibleResults);
      const second = compareResults(root, "compatible-vs-full", compatibleResults, fullResults);
      const differences = [
        ...first.differences,
        ...second.differences,
        ...invariantDifferences(root, full),
      ];
      const texts = new Map(full.notes.map((note) => [note.path, note.text]));
      const allowed: Record<string, Difference[]> = {};
      const notAllowed: Difference[] = [];
      for (const difference of differences) {
        if (difference.section === "normalize") {
          difference.features = yamlFeatures(texts.get(difference.key) ?? "");
        }
        if (difference.section === "health.stale_inbox") {
          const model = difference.comparison === "compatible-vs-full" ? full : compatible;
          difference.created = Object.fromEntries(
            model.notes
              .filter((note) => note.path.startsWith("inbox/"))
              .map((note) => [note.path, note.properties.created]),
          );
        }
        const entry = ALLOWLIST.find((candidate) => candidate.matches(difference));
        if (entry === undefined) notAllowed.push(difference);
        else allowed[entry.id] = [...(allowed[entry.id] ?? []), difference];
      }
      unexpected += notAllowed.length;
      const counts = Object.fromEntries(
        Object.entries(allowed).map(([id, list]) => [id, list.length]),
      );
      console.log(
        `${root}: ${full.notes.length} notes, ${first.compared} results compared, ` +
          `${notAllowed.length} unexpected differences, allowed ${JSON.stringify(counts)}`,
      );
      console.log(
        `  python ${pythonSeconds.toFixed(1)} s, typescript ${typescriptSeconds.toFixed(1)} s; ` +
          `load ${(loadSeconds * 1000).toFixed(0)} ms, slowest depth-2 subgraph ` +
          `${(slowestSubgraph.seconds * 1000).toFixed(1)} ms (${slowestSubgraph.path})`,
      );
      for (const difference of notAllowed.slice(0, 20)) {
        console.log(`  ${difference.comparison} ${difference.section} ${difference.key}`);
        console.log(`    python:     ${JSON.stringify(difference.python)?.slice(0, 400)}`);
        console.log(`    typescript: ${JSON.stringify(difference.typescript)?.slice(0, 400)}`);
      }
      report.push({
        vault: root,
        today: day,
        notes: full.notes.length,
        python_refused_notes: refused.sort(),
        subgraph_depth2_notes: depth2.length,
        compared: first.compared,
        unexpected: notAllowed,
        allowed,
        seconds: {
          python: pythonSeconds,
          typescript: typescriptSeconds,
          typescript_load: loadSeconds,
          slowest_subgraph_depth2: slowestSubgraph,
        },
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (values.report) {
    const allowlist = ALLOWLIST.map(({ id, reason }) => ({ id, reason }));
    writeFileSync(values.report, `${JSON.stringify({ allowlist, vaults: report }, null, 2)}\n`);
    console.log(`report: ${values.report}`);
  }
  process.exit(unexpected === 0 ? 0 : 1);
}

await main();
