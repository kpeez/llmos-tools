/**
 * The `llmos` commands. Each one keeps the command name and JSON
 * output shape of the retired Python CLI. Reads answer from one vault
 * model; writes are headless file writes (`write.ts`), except `move` and
 * `create --template`, which need the running Obsidian app.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { checkNote } from "./authoring.ts";
import { bodySection, summary as claimsSummary, lintClaims } from "./claims-lint.ts";
import { type Command, type Context, type OptionSpec, UsageError, type Values } from "./cli.ts";
import { type Day, parseDay, readRecentDailies, refuseMarkerSyntax } from "./daily.ts";
import { discover } from "./discover.ts";
import { renderReference, renderSkill } from "./docs.ts";
import { isClean, qmdSection, RUN_RECORDS, summary, vaultHealth } from "./health.ts";
import { destinationProperties } from "./inbox.ts";
import { DAILY_DIR } from "./layout.ts";
import {
  forgetMemory,
  MAX_INDEX_BYTES,
  MAX_INDEX_LINES,
  MEMORY_TYPES,
  type MemoryInput,
  type MemoryScope,
  type MemoryType,
  memoryScope,
  projectScope,
  readMemoryIndex,
  saveMemory,
} from "./memory.ts";
import { runObsidian } from "./obsidian.ts";
import {
  indexedPaths,
  openQmd,
  type QmdLocation,
  qmdLocation,
  reindex,
  type Searcher,
  type SearchMode,
  search,
  searchMemoryNotes,
  unembeddedCount,
} from "./qmd.ts";
import { readConfig, validated } from "./root.ts";
import { afterMemoryWrite, servicePaths, serviceStatus, viaService } from "./service-client.ts";
import { captureSource } from "./sources.ts";
import { type Note, readSource, readText, type VaultModel } from "./vault.ts";
import {
  appendContent,
  appendThought,
  createNote,
  newTarget,
  realTarget,
  removeProperty,
  setProperty,
  stampProperties,
} from "./write.ts";

const TOOLS = resolve(import.meta.dir, "../..");
export const DEFAULT_REFERENCE_PATH = join(
  TOOLS,
  "skills",
  "vault-cli",
  "references",
  "commands.md",
);
export const DEFAULT_SKILL_PATH = join(TOOLS, "skills", "vault-cli", "SKILL.md");
const DAILY_TEMPLATE = "daily-note";

function vaultOption(help: string): Record<string, OptionSpec> {
  return { vault: { type: "string", default: "llmos", metavar: "NAME", help } };
}

// Handlers are also called without the command line (the MCP server), so
// they check their values themselves instead of trusting `parseValues`.

/** A string value. */
function str(values: Values, name: string): string {
  const value = values[name];
  if (typeof value !== "string") throw new UsageError(`${name} must be a string`);
  return value;
}

/** A string value that may be absent. */
function optionalStr(values: Values, name: string): string | undefined {
  return values[name] === undefined ? undefined : str(values, name);
}

/**
 * The `--vault` name: "llmos" for the llmOS vault, else the folder name of
 * another vault in Obsidian's registry (`resolveVaultRoot` refuses an
 * unknown name). A path is never a vault name.
 */
function vaultName(values: Values): string {
  const vault = str(values, "vault");
  if (
    vault === "" ||
    vault === "." ||
    vault === ".." ||
    /[/\\]/.test(vault) ||
    CONTROL.test(vault)
  ) {
    throw new UsageError(
      `vault must be llmos or a vault folder name, got ${JSON.stringify(vault)}`,
    );
  }
  return vault;
}

/** A whole number of at least `min`. */
function count(values: Values, name: string, min: number): number {
  const value = values[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new UsageError(`${name} must be a whole number of at least ${min}`);
  }
  return value;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** A property name: not empty, no surrounding spaces, no control characters. */
function propertyKey(values: Values): string {
  const key = str(values, "key");
  if (key === "" || key.trim() !== key || CONTROL.test(key) || key.includes("\t")) {
    throw new UsageError(`invalid property name ${JSON.stringify(key)}`);
  }
  return key;
}

/** The refusal for a property that only the job of `record` may write. */
function runRecordRefusal(record: (typeof RUN_RECORDS)[number]): string {
  return `'${record.property}' on ${record.note} is the run record of \`${record.job}\`; only \`${record.command}\` sets it`;
}

/**
 * Refuse a property that only its job may write, in the llmOS vault: a run
 * record `health` reads. The note counts by its real path, so a link to it is
 * refused too.
 */
function refuseRunRecord(vault: string, root: string, path: string, key: string): void {
  if (vault !== "llmos") return;
  for (const record of RUN_RECORDS) {
    if (key !== record.property) continue;
    let same = path === record.note;
    try {
      same ||= realTarget(root, path) === realTarget(root, record.note);
    } catch {
      // The record note is missing, or the path is outside the vault: nothing to protect here.
    }
    if (same) throw new Error(runRecordRefusal(record));
  }
}

/** A property value: one line, no control characters except tabs. */
function propertyValue(values: Values): string {
  const value = str(values, "value");
  if (CONTROL.test(value)) {
    throw new UsageError("a property value must be one line without control characters");
  }
  return value;
}

/** A template name: not empty, relative, no `..` part, no control characters. */
function templateName(values: Values): string {
  const name = str(values, "template");
  if (name === "" || name.startsWith("/") || name.split("/").includes("..") || CONTROL.test(name)) {
    throw new UsageError(`invalid template name ${JSON.stringify(name)}`);
  }
  return name;
}

/** A note as `read`, `list`, and the daily verbs print it. */
function noteJson(model: VaultModel, note: Note): object {
  return {
    name: note.name,
    path: model.absolutePath(note),
    properties: note.properties,
    body: note.body,
  };
}

/** A note read straight from its file, printed as `noteJson` prints it. */
function fileJson(root: string, relative: string): object {
  const source = readSource(relative, readText(join(root, relative)));
  return {
    name: basename(relative, ".md"),
    path: join(root, relative),
    properties: source.properties,
    body: source.body,
  };
}

/** The context's today as a day number. */
function today(context: Context): Day {
  const day = parseDay(context.today());
  if (day === null) throw new Error(`today is not a date: '${context.today()}'`);
  return day;
}

/** The llmOS root, or an error for a vault without the llmOS daily-note contract. */
function llmosOnly(vault: string, context: Context): string {
  if (vault !== "llmos") {
    throw new Error(
      `daily helpers are an llmOS-profile feature; vault '${vault}' has no daily-note contract`,
    );
  }
  return context.root(vault);
}

/** Today's daily note, created from the vault's daily template (through Obsidian) when missing. */
function ensureDaily(root: string, context: Context): string {
  const day = context.today();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) throw new Error(`today is not a date: '${day}'`);
  const relative = `${DAILY_DIR}/${day}.md`;
  if (!existsSync(newTarget(root, relative))) {
    runObsidian(root, "create", relative, { template: DAILY_TEMPLATE }, context.obsidian);
  }
  return relative;
}

function withoutFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** The collection's indexed paths and the index's unembedded count; nulls when qmd is unavailable. */
async function qmdIndexState(
  context: Context,
  collection: string,
): Promise<{ paths: Set<string> | null; unembedded: number | null }> {
  const location = qmdLocation(context.env);
  // Never create an index just to report on it.
  if (!existsSync(location.dbPath)) return { paths: null, unembedded: null };
  try {
    const store = await openQmd(location, false);
    try {
      return { paths: await indexedPaths(store, collection), unembedded: unembeddedCount(store) };
    } finally {
      await store.close();
    }
  } catch {
    return { paths: null, unembedded: null };
  }
}

/** Options that narrow a note's JSON to what the caller needs. */
const PROPERTIES_ONLY: OptionSpec = {
  type: "boolean",
  default: false,
  help: "Leave out the body: print only the name, path, and properties.",
};

/** A note's JSON with its body left out when `--properties-only` is set. */
function narrowed(json: object, values: Values): object {
  if (values["properties-only"] !== true) return json;
  const { body: _body, ...rest } = json as { body?: string };
  return rest;
}

const read: Command = {
  name: "read",
  summary: "Print one note's frontmatter and body as JSON.",
  description: `Use when an agent needs a note's current content or properties -- to
inspect before editing, or to script a decision on a property value. Works
with Obsidian closed. --section prints only the text under one heading
(its subsections included, the heading line left out) and adds a
\`section\` key; a heading that is missing or named twice is an error that
lists the note's headings. --properties-only leaves out the body.
Do NOT use when you need every note in the vault -- use \`list\`, which walks
the vault once instead of resolving names one at a time.`,
  arguments: [{ name: "note", help: "Note basename (wikilink-style) or vault-relative path." }],
  options: {
    ...vaultOption("Which registered vault to read from."),
    section: {
      type: "string",
      metavar: "HEADING",
      help: "Print only the body under this heading, matched as a [[note#heading]] link matches it.",
    },
    "properties-only": PROPERTIES_ONLY,
  },
  exampleOutput: `{"name": "alpha", "path": "/vault/notes/alpha.md",
 "properties": {"topics": ["gardening"]}, "body": "# Alpha\\n..."}`,
  example: "llmos read alpha --vault llmos --section Results",
  run(values, context) {
    const model = context.model(context.root(vaultName(values)));
    const note = model.resolveNote(str(values, "note"));
    const json = noteJson(model, note);
    if (values.section === undefined) return { json: narrowed(json, values) };
    const heading = str(values, "section");
    return { json: { ...json, section: heading, body: bodySection(note.body, heading) } };
  },
};

/** A vault-relative folder: relative, no `..` part, no control characters. */
function folderPrefix(values: Values): string | null {
  if (values.folder === undefined) return null;
  const folder = str(values, "folder").replace(/\/+$/, "");
  if (
    folder === "" ||
    folder.startsWith("/") ||
    folder.split("/").includes("..") ||
    CONTROL.test(folder)
  ) {
    throw new UsageError(`invalid folder ${JSON.stringify(values.folder)}`);
  }
  return `${folder}/`;
}

const list: Command = {
  name: "list",
  summary: "Print every note in the vault with its frontmatter and body as JSON.",
  description: `Use when an agent needs to enumerate or scan notes -- e.g. finding
every note missing a property before scripting a bulk decision, or the
status of every experiment in one project. --folder keeps the notes under
one vault-relative folder; --properties-only leaves out the bodies.
Do NOT use when you already know which note you want -- use \`read\`.`,
  arguments: [],
  options: {
    ...vaultOption("Which registered vault to enumerate."),
    folder: {
      type: "string",
      metavar: "PATH",
      help: "Only the notes under this vault-relative folder, at any depth.",
    },
    "properties-only": PROPERTIES_ONLY,
  },
  exampleOutput: `[{"name": "alpha", "path": "/vault/notes/alpha.md",
  "properties": {"topics": ["gardening"]}, "body": "# Alpha\\n..."}]`,
  example: "llmos list --vault llmos --folder projects/llmos --properties-only",
  run(values, context) {
    const model = context.model(context.root(vaultName(values)));
    const prefix = folderPrefix(values);
    const notes =
      prefix === null ? model.notes : model.notes.filter((n) => n.path.startsWith(prefix));
    return { json: notes.map((note) => narrowed(noteJson(model, note), values)) };
  },
};

const check: Command = {
  name: "check",
  summary: "Review one note for unlinked references and Markdown that renders wrongly.",
  description: `Reports body links separately from frontmatter links, plus the first
unlinked .md reference to each known target (code unlinked-note). It also
reports Markdown that makes Obsidian render the note wrongly: a table row
with the wrong number of cells (table-column-count), an empty link
(empty-link), a reversed link (reversed-link), an unescaped alias pipe in
a table wikilink, which splits the cell (table-wikilink-pipe; write
[[target\\|label]]), and a paragraph or list item split over several lines,
which Obsidian shows as broken lines (hard-wrapped-paragraph; block quotes
keep their lines). Notes under raw/ and dot folders get no Markdown
findings. Exits 1 when findings need review, 0 otherwise. Never rewrites
content; works with Obsidian closed. This is a conservative authoring aid,
not a style linter: code examples, missing files, and ambiguous filenames
are ignored. A clean result does not certify useful connections, link
resolution, Base formulas, or rendering. Use \`neighbors\` and Obsidian for
those checks.`,
  arguments: [{ name: "note", help: "Note basename or vault-relative path." }],
  options: vaultOption("Which registered vault to check."),
  exampleOutput: `{"path": "notes/alpha.md", "body_links": [], "property_links": ["Project"],
 "findings": [{"code": "unlinked-note", "line": 7, "target": "notes/beta",
               "message": "Existing note reference \\"beta.md\\": link to \\"notes/beta\\" ..."}]}`,
  example: "llmos check projects/study/manuscript/README.md --vault llmos",
  run(values, context) {
    const model = context.model(context.root(vaultName(values)));
    const report = checkNote(model, model.resolveNote(str(values, "note")));
    return { json: report, exitCode: report.findings.length > 0 ? 1 : 0 };
  },
};

const neighbors: Command = {
  name: "neighbors",
  summary: "Print one note's outgoing links, backlinks, and shared-topic siblings.",
  description: `Use when an agent needs a note's local link neighborhood -- e.g. before
editing a note, to see what already points at it or shares its topics.
Works with Obsidian closed; the graph is built fresh from disk.
Do NOT use when you need more than one hop out -- use \`subgraph\`.`,
  arguments: [{ name: "note", help: "Note basename (wikilink-style) or vault-relative path." }],
  options: vaultOption("Which registered vault to read from."),
  exampleOutput: `{"note": "alpha", "outgoing": ["beta"], "unresolved_outgoing": ["ghost"],
 "backlinks": ["delta"], "topic_siblings": ["beta", "gamma"]}`,
  example: "llmos neighbors alpha --vault llmos",
  run(values, context) {
    const model = context.model(context.root(vaultName(values)));
    return { json: model.neighbors(str(values, "note")) };
  },
};

const subgraph: Command = {
  name: "subgraph",
  summary: "Print the transitive neighborhood of a note out to `depth` hops as JSON.",
  description: `Use when an agent needs the broader cluster around a note -- e.g. to
scope a rename's blast radius, or to see a topic's full note cluster.
Unresolved wikilinks are listed, never raised as errors.
Do NOT use when you only need the immediate neighbors -- \`neighbors\` is
cheaper and returns the same one-hop data without traversal.`,
  arguments: [{ name: "note", help: "Note basename (wikilink-style) or vault-relative path." }],
  options: {
    ...vaultOption("Which registered vault to read from."),
    depth: {
      type: "integer",
      default: 1,
      metavar: "N",
      help: "Number of hops to traverse outward from the note.",
    },
  },
  exampleOutput: `{"root": "alpha", "nodes": ["alpha", "beta", "delta", "gamma"],
 "unresolved": ["ghost"],
 "edges": [["alpha", "beta", "link"], ["delta", "alpha", "link"]]}`,
  example: "llmos subgraph alpha --vault llmos --depth 2",
  run(values, context) {
    const model = context.model(context.root(vaultName(values)));
    return { json: model.subgraph(str(values, "note"), count(values, "depth", 0)) };
  },
};

const health: Command = {
  name: "health",
  summary:
    "Report vault hygiene: orphans, dead-ends, unresolved wikilinks, schema violations, stale inbox items, overdue jobs, and qmd index gaps.",
  description: `Use when starting a vault-maintenance pass -- e.g. after a vault change --
to see every hygiene defect in one headless call. Each section degrades
independently: when qmd has no index or no such collection, the report
carries a notice instead of failing. Works with Obsidian closed. Exits 1 if
any section has findings, 0 on a clean vault, so cron can branch on it.
llmOS schema-violation checks and overdue_jobs run only for --vault llmos.
A wikilink in a fenced code block or an inline code span is not a link. A link
or embed that names an existing non-note file (an image, a .base file) is
resolved by its path, then by its file name. An orphan is a note that no other
note links to and that has no valid category. In the llmos vault, a note has a
valid category when its \`categories\` names a hub note in categories/ (the
hub's Base lists the note), so such a note is never an orphan. In the llmos
vault the inbox is every note in raw/ except a captured source's
raw/<slug>/source.md; in another vault it is inbox/. A note under
categories/templates/ is scaffolding in the llmos vault: it is never an orphan or a dead-end, its placeholder links (such as
{{title}}) are not reported, and a link from it does not count as inbound. A
link to a template still resolves. In another vault (--vault NAME) only
links count, and templates are checked like any note.
Orphans, dead-ends, and the referrer of an unresolved link are vault-relative
note paths with .md, because many notes share a file name.
overdue_jobs lists the jobs whose run record is missing, not a valid past
YYYY-MM-DD date, or too old: \`discover\` (the \`discovered\` date on
categories/Knowledge.md, max 10 days) and \`daily-activity\`, the nightly
digest on the host that runs its timer (the \`digested\` date on
categories/Reviews.md, max 3 days). Run the job to clear it; for
\`daily-activity\`, read its journal on that host first. qmd_unembedded
counts the documents in the whole qmd index that still need embedding (the
plugin's Stop hook updates only keyword search); it is informational and does
not change the exit code. Run \`reindex\` to embed them.
Do NOT use when you only need one relation on one note -- \`neighbors\` is
cheaper and does not walk the whole vault.`,
  arguments: [],
  options: {
    ...vaultOption("Which registered vault to check."),
    json: { type: "boolean", help: "Print JSON instead of a readable summary." },
    "qmd-collection": {
      type: "string",
      default: "llmos",
      metavar: "NAME",
      help: "qmd collection to check for index gaps.",
    },
    "stale-after-days": {
      type: "integer",
      default: 14,
      metavar: "DAYS",
      help: "Age in days after which an inbox item counts as stale.",
    },
  },
  exampleOutput: `{"orphans": ["notes/gamma.md"], "dead_ends": ["notes/beta.md"],
 "unresolved_links": [{"referrer": "notes/alpha.md", "target": "ghost"}],
 "schema_violations": [], "stale_inbox": [],
 "overdue_jobs": [{"job": "discover", "last_success": null, "max_age_days": 10},
  {"job": "daily-activity", "last_success": "2026-10-03", "max_age_days": 3}], "qmd_gaps": [], "qmd_unembedded": 0,
 "qmd_notice": null}`,
  example: "llmos health --vault llmos --json",
  async run(values, context) {
    const vault = vaultName(values);
    const collection = str(values, "qmd-collection");
    const model = context.model(context.root(vault));
    const qmd = await qmdIndexState(context, collection);
    const day = today(context);
    const report = {
      ...vaultHealth(model, {
        profile: vault === "llmos" ? "llmos" : "core",
        staleAfterDays: count(values, "stale-after-days", 0),
        today: day,
      }),
      ...qmdSection(model, qmd.paths, collection, qmd.unembedded),
    };
    const exitCode = isClean(report) ? 0 : 1;
    return values.json ? { json: report, exitCode } : { text: summary(report), exitCode };
  },
};

const discoverCommand: Command = {
  name: "discover",
  summary: "Rank clusters of notes that restate the same works, as candidates to consolidate.",
  description: `Use when \`health\` reports discover as overdue, or when you look for the
next topic for \`consolidate-knowledge\`. It clusters the vault's notes
outside knowledge/, daily/, and categories/, except the rule notes at the
vault root and the captured sources (raw/<slug>/source.md). The signals are the arXiv ids and DOIs that notes share, the
dangling links (not an embed of an existing Base or image) and missing topic
notes that they share, and mutual nearest neighbors from the vectors already in the qmd index (no model loads).
Clusters of three notes or more are ranked: uncovered ones first, then those
whose notes already link one note in knowledge/ (covered_by). Without a qmd
index it skips the similarity signal and says so in qmd_notice.
It writes the JSON report to <vault root>/../artifacts/discover/YYYY-MM-DD.json,
or to --out DIR, and prints it. It refuses to run when that artifacts folder
is missing and --out is not given.
For --vault llmos, after it writes the report, it sets \`discovered\` (today's
date) on categories/Knowledge.md, and \`updated\` there, in one write.
\`health\` reads that date, so any host that syncs the vault sees the run.
Before any work it runs the same edit without writing, and fails when that
note is missing, is a symbolic link, or has frontmatter that the edit cannot
rewrite. --no-record skips the write and those checks, for
probes on vault copies. It writes nothing else in the vault.
Do NOT use when you only want to search -- use \`search\`.`,
  arguments: [],
  options: {
    ...vaultOption("Which registered vault to scan."),
    top: {
      type: "integer",
      default: 10,
      metavar: "N",
      help: "Report at most this many clusters.",
    },
    out: {
      type: "string",
      metavar: "DIR",
      help: "Folder for the report file; must be outside the vault. Default: <vault root>/../artifacts/discover.",
    },
    "qmd-collection": {
      type: "string",
      default: "llmos",
      metavar: "NAME",
      help: "qmd collection whose stored vectors give the similarity signal.",
    },
    "no-record": {
      type: "boolean",
      help: "Do not set the discovered date on categories/Knowledge.md (a probe run).",
    },
  },
  exampleOutput: `{"generated_at": "2026-10-08T09:30:00.000Z", "vault": "llmos",
 "report_path": "/home/me/code/llmos/artifacts/discover/2026-10-08.json", "qmd_notice": null,
 "clusters": [{"rank": 1, "score": 7.4,
   "notes": ["projects/a/notes.md", "projects/b/notes.md", "raw/c.md"], "covered_by": null,
   "signals": {"shared_ids": [{"id": "arxiv:2403.12345", "notes": ["raw/c.md", "projects/a/notes.md"]}],
               "shared_dangling": 0, "shared_topics": 0, "similar_pairs": 2}}]}`,
  example: "llmos discover --top 5",
  async run(values, context) {
    const vault = vaultName(values);
    const root = context.root(vault);
    return {
      json: await discover(context.model(root), {
        vault,
        top: count(values, "top", 1),
        out: values.out === undefined ? undefined : str(values, "out"),
        collection: str(values, "qmd-collection"),
        env: context.env,
        today: context.today(),
        // The record is the llmOS vault's; a plain vault has no manual jobs.
        record: vault === "llmos" && values["no-record"] !== true,
      }),
    };
  },
};

const create: Command = {
  name: "create",
  summary: "Create a new note; with --template, Obsidian creates it from a vault template.",
  description: `Use when an agent needs a brand-new note on disk -- e.g. filing a new
project note. Without --template the note is written directly (works with
Obsidian closed). With --template the running Obsidian app creates it, so
the template is expanded; this exits 3 when Obsidian is not running.
Do NOT use when the note already exists -- this refuses to overwrite a
file; edit the note instead. In the llmos vault it refuses content that
sets a run record (\`discovered\` on categories/Knowledge.md, \`digested\` on
categories/Reviews.md): only its job sets it.`,
  arguments: [{ name: "name", help: 'Vault-relative note path (".md" appended if missing).' }],
  options: {
    ...vaultOption("Which registered vault to create the note in."),
    content: { type: "string", metavar: "TEXT", help: "Initial content." },
    template: { type: "string", metavar: "NAME", help: "Name of a vault template to apply." },
  },
  exampleOutput: "Created: projects/agent-toolbox.md",
  example: "llmos create projects/agent-toolbox --template project --vault llmos",
  run(values, context) {
    const vault = vaultName(values);
    const root = context.root(vault);
    const name = str(values, "name");
    const target = name.endsWith(".md") ? name : `${name}.md`;
    const content = values.content as string | undefined;
    const record = RUN_RECORDS.find((entry) => entry.note === normalize(target));
    if (
      vault === "llmos" &&
      record !== undefined &&
      content !== undefined &&
      // Line endings as the vault model reads them, so CRLF cannot hide the block.
      record.property in readSource(target, content.replace(/\r\n?/g, "\n")).properties
    ) {
      throw new Error(runRecordRefusal(record));
    }
    const template = values.template === undefined ? undefined : templateName(values);
    newTarget(root, target); // both branches: the new note must stay inside the vault
    if (template !== undefined) {
      const params: Record<string, string> = { template };
      if (content !== undefined) params.content = content;
      return {
        text: withoutFinalNewline(runObsidian(root, "create", target, params, context.obsidian)),
      };
    }
    const text = content ?? "";
    createNote(root, target, text === "" || text.endsWith("\n") ? text : `${text}\n`);
    return { text: `Created: ${target}` };
  },
};

const move: Command = {
  name: "move",
  summary: "Move or rename a note via obsidian-cli, rewriting every backlink.",
  description: `Use when an agent needs to relocate or rename a note -- the sanctioned
alternative to raw \`mv\`/\`git mv\` (the PreToolUse Bash guard denies those
inside a vault and points here). Requires Obsidian to be running, because
only the app rewrites backlinks; exits 3 when it is not.
Do NOT use when you'd reach for raw \`mv\`/\`rm\` on a vault note -- see the
guard hook's message for why.`,
  arguments: [
    { name: "note", help: "Note name (wikilink-style resolution) or vault-relative path." },
    { name: "to", help: "Destination folder or path." },
  ],
  options: vaultOption("Which registered vault the note lives in."),
  exampleOutput: "Moved: notes/alpha.md -> projects/demo/alpha.md",
  example: "llmos move alpha projects/demo/alpha.md --vault llmos",
  run(values, context) {
    const root = context.root(vaultName(values));
    const note = context.model(root).resolveNote(str(values, "note"));
    newTarget(root, str(values, "to")); // the destination must stay inside the vault
    const output = runObsidian(
      root,
      "move",
      note.path,
      { to: str(values, "to") },
      context.obsidian,
    );
    return { text: withoutFinalNewline(output) };
  },
};

const append: Command = {
  name: "append",
  summary: "Append content to the end of an existing note.",
  description: `Use when an agent needs to add content to the end of a note without
rewriting it by hand -- e.g. logging a quick note. The content starts on a
new line. Writes the file directly (atomically), so it works with Obsidian
closed; the note is saved in the canonical frontmatter form. A note whose
frontmatter cannot be read is left untouched (exit 1).
Do NOT use when changing frontmatter -- use \`set-property\`.`,
  arguments: [
    { name: "note", help: "Note name (wikilink-style resolution) or vault-relative path." },
    { name: "content", help: "Content to append." },
  ],
  options: vaultOption("Which registered vault the note lives in."),
  exampleOutput: "Appended to: notes/alpha.md",
  example: 'llmos append alpha "One more thought." --vault llmos',
  run(values, context) {
    const root = context.root(vaultName(values));
    const note = context.model(root).resolveNote(str(values, "note"));
    appendContent(root, note.path, str(values, "content"));
    return { text: `Appended to: ${note.path}` };
  },
};

const setPropertyCommand: Command = {
  name: "set-property",
  summary: "Set a property on a note.",
  description: `Use when an agent needs to set or update a single frontmatter property
without hand-editing YAML -- e.g. flipping a status flag. The value is
written as a string, except for the list properties below. Writes the file
directly (atomically), so it works
with Obsidian closed. A note whose frontmatter cannot be read is left
untouched (exit 1).
\`categories\`, \`project\`, and \`topics\` are lists and append-only: setting
one adds \`value\` (one item, such as one wikilink) to the existing list
instead of overwriting it. To replace a list, remove the property first.
Do NOT use when rewriting \`created\` -- it is immutable and this call
exits with an error. In the llmos vault, \`discovered\` on
categories/Knowledge.md and \`digested\` on categories/Reviews.md are the
run records of \`discover\` and the nightly digest: this call refuses them,
also through a link to those notes.`,
  arguments: [
    { name: "note", help: "Note name (wikilink-style resolution) or vault-relative path." },
    { name: "key", help: "Property name." },
    { name: "value", help: "Property value to set, or one item to add to a list property." },
  ],
  options: vaultOption("Which registered vault the note lives in."),
  exampleOutput: "Set: status = active",
  example: "llmos set-property alpha status active --vault llmos",
  run(values, context) {
    const vault = vaultName(values);
    const root = context.root(vault);
    const note = context.model(root).resolveNote(str(values, "note"));
    const key = propertyKey(values);
    const value = propertyValue(values);
    refuseRunRecord(vault, root, note.path, key);
    setProperty(root, note.path, key, value);
    return { text: `Set: ${key} = ${value}` };
  },
};

const removePropertyCommand: Command = {
  name: "remove-property",
  summary: "Remove a property from a note.",
  description: `Use when an agent needs to delete a frontmatter property entirely -- e.g.
clearing a stale \`status\` flag. Writes the file directly (atomically), so
it works with Obsidian closed. A property that is not set is reported and
nothing is written.
Do NOT use when targeting \`created\` -- it is immutable and this call exits
with an error. In the llmos vault, \`discovered\` on
categories/Knowledge.md and \`digested\` on categories/Reviews.md are the
run records of \`discover\` and the nightly digest: this call refuses them,
also through a link to those notes.`,
  arguments: [
    { name: "note", help: "Note name (wikilink-style resolution) or vault-relative path." },
    { name: "key", help: "Property name to remove." },
  ],
  options: vaultOption("Which registered vault the note lives in."),
  exampleOutput: "Removed: status",
  example: "llmos remove-property alpha status --vault llmos",
  run(values, context) {
    const vault = vaultName(values);
    const root = context.root(vault);
    const note = context.model(root).resolveNote(str(values, "note"));
    const key = propertyKey(values);
    refuseRunRecord(vault, root, note.path, key);
    const removed = removeProperty(root, note.path, key);
    return { text: removed ? `Removed: ${key}` : `Not set: ${key}` };
  },
};

const fileInbox: Command = {
  name: "file-inbox",
  summary:
    "File an inbox note: move it via obsidian-cli, stamp its destination properties, and record it in today's daily note.",
  description: `Use when an inbox capture has a real home -- the sanctioned ritual so an
agent never files a note half-way. The steps run in order, and a failed
step stops the rest: move the note (needs the running Obsidian app; exits 3
when it is not running), add the \`categories\`/\`project\` properties the
destination implies, and append a line under \`## Thoughts\` in today's daily
note. Safe to re-run: a note already at \`destination\` is not moved
again, and existing properties are kept. Only the move needs Obsidian.
Do NOT use when \`destination\`'s top-level folder is not \`knowledge\`,
\`projects\`, or \`raw\` -- this exits with an error before any move is
attempted.`,
  arguments: [
    {
      name: "note",
      help: "Note name (wikilink-style resolution) or vault-relative path of the inbox item.",
    },
    { name: "destination", help: 'Vault-relative destination path (".md" appended if missing).' },
  ],
  options: vaultOption('Must be "llmos" -- inbox filing is an llmOS-profile feature.'),
  exampleOutput: "Filed: capture-1 -> knowledge/some-note.md",
  example: "llmos file-inbox capture-1 knowledge/some-note.md",
  run(values, context) {
    const root = llmosOnly(vaultName(values), context);
    const name = str(values, "note");
    const destination = str(values, "destination");
    const relative = destination.endsWith(".md") ? destination : `${destination}.md`;
    // A path that leaves the vault is refused as such before its filing area is read.
    const target = newTarget(root, relative);
    const stamps = destinationProperties(root, relative);
    if (!existsSync(target)) {
      const note = context.model(root).resolveNote(name);
      // Refuse before moving, so an unreadable block never strands the note.
      if (note.frontmatterError) throw note.frontmatterError;
      realTarget(root, note.path); // and a link that leaves the vault is never filed

      runObsidian(root, "move", note.path, { to: relative }, context.obsidian);
    }
    stampProperties(root, relative, stamps);
    const daily = ensureDaily(root, context);
    appendThought(root, daily, `Filed \`${name}\` from inbox -> \`${relative}\`.`);
    return { text: `Filed: ${name} -> ${relative}` };
  },
};

const sourceAdd: Command = {
  name: "source add",
  summary:
    "Capture an arXiv paper, web page, or PDF into a frozen source folder: raw bytes, figures, converted text, and a manifest.",
  description: `Use when an inbox item is a source worth keeping as the original: an arXiv
paper, an open-access web page, or a PDF. The capture goes to \`raw/<slug>/\`
and holds \`raw.html\` or \`raw.pdf\`, \`assets/\` (the images of the
captioned figures), and \`source.md\`, whose frontmatter is the manifest
(\`origin\`, \`source_id\`, \`retrieved\`, \`licence\`, \`converter\`,
\`sha256_raw\`, \`sha256_text\`, \`figures\`). An arXiv paper is read from its
\`arxiv.org/html/<id>\` version, else from its PDF, and an ID without a
version is pinned to the version fetched (\`arxiv:1811.00743v2\`).
\`source\` accepts an arXiv ID, an arXiv or web URL, a PDF file (a
vault-relative inbox drop such as \`raw/paper.pdf\`, or a file system path),
or an inbox note that holds only a URL. The inbox item stays where it is.
A web page is converted by defuddle. When defuddle keeps less than a tenth
of the words of a page of 500 words or more, it runs again on the page's
article container (\`.article.fulltext-view\`, \`[role=main]\`, \`main\`,
\`article\`), and \`converter\` names the selector; when none holds the
text, the capture keeps defuddle's text and prints a warning. A PDF, a URL that serves one, and an
arXiv paper without HTML are converted by MinerU on this machine: set
\`LLMOS_MINERU\` to the path of \`mineru-kit\`, or put \`mineru-kit\` on
\`PATH\`. MinerU takes minutes for a long paper and prints its progress on
stderr. A PDF file's source ID is \`sha256:<hash of its bytes>\`; give
\`--origin\` for the URL it came from and \`--licence\` with the licence the
PDF states. These two options are refused for a capture that reads them
from the source. Writes the files directly, so it works with Obsidian
closed. Only public http and https hosts are requested (no IP addresses,
no local or private networks, at most five redirects, at most 50 MB a
file). A figure image from a non-public host, with a failing status, or of a
non-image type is skipped and named in the output. A source already
captured is not fetched, converted, or changed: the command says so and exits 0. An ID without a version counts any captured version of
that paper as captured; ask for \`<id>vN\` to capture a newer one. No agent
edits a source folder afterwards. When MinerU is missing or fails, this exits
1 and writes nothing.`,
  arguments: [
    {
      name: "source",
      help: "An arXiv ID (1811.00743 or 1811.00743v2), a URL, a PDF file, or a vault-relative inbox note that holds only a URL.",
    },
  ],
  options: {
    ...vaultOption('Must be "llmos" -- sources are an llmOS-profile feature.'),
    origin: {
      type: "string",
      metavar: "URL",
      help: "A PDF file only: the http or https URL it came from, recorded as `origin` (default `file:<name>`).",
    },
    licence: {
      type: "string",
      metavar: "TEXT",
      help: "A PDF file or web PDF only: the licence as the PDF states it (default `not stated`).",
    },
  },
  exampleOutput: `Captured: arxiv:1811.00743v2 -> raw/arxiv-1811.00743v2 (4 figures)
Captured: sha256:9f2c...e1 -> raw/biorxiv-org-content-10-1101-2026-01-01-1-full-pdf-3c5d9a1e (4 figures)`,
  example: `llmos source add 1811.00743
llmos source add raw/paper.pdf --origin https://www.biorxiv.org/content/10.1101/2026.01.01.1.full.pdf --licence "CC BY 4.0"`,
  async run(values, context) {
    const root = llmosOnly(vaultName(values), context);
    const result = await captureSource(root, str(values, "source"), context, {
      origin: optionalStr(values, "origin"),
      licence: optionalStr(values, "licence"),
    });
    const skipped =
      result.skipped.map((line) => `\nSkipped image: ${line}`).join("") +
      result.warnings.map((line) => `\nWarning: ${line}`).join("");
    return {
      text:
        result.status === "captured"
          ? `Captured: ${result.sourceId} -> ${result.folder} (${result.figures} figures)${skipped}`
          : `Already captured: ${result.sourceId} at ${result.folder}; nothing changed.`,
    };
  },
};

const claimsLint: Command = {
  name: "claims lint",
  summary:
    "Check the fact and conflict callouts of notes: each quote occurs in its source section, and each number of a fact occurs in its quote.",
  description: `Use before opening a consolidation pull request, and whenever a note with
\`[!fact]\` or \`[!conflict]\` callouts changes. Each fact has a status title
(drafted, checked, verified, superseded, or \`flagged: <reason>\`), the fact
text, one quoted passage, a final \`— [[source#heading|label]]\` line, and a
\`^fact-<slug>\` block ID on its own line after a blank line. The format and
the rules are in \`docs/compiled-facts.md\` in the llmOS plugin root.
Per fact, it checks that the quote occurs in the linked heading's section of
the source (case and punctuation as written; white space, Unicode forms,
quote marks, ligatures, soft hyphens, LaTeX symbols, and Markdown markup are
normalized; \`…\` and \`[...]\` skip text, and the parts must occur in order).
A quote needs at least 6 words, and each part between elisions at least 3; for
a table, quote the whole row with its row label.
Every number in the fact must occur in the quote: 6,280 equals 6280, exponents
(\`59e-9\`, \`10^4\`) and a minus sign must match, and a \`%\` or \`±\` on the
number must be on the quote's number too. Number words (\`fifty\`, \`one\`, \`double-blind\`) in a fact are
findings unless the quote uses the same word. Digits around \`x\` are two
numbers (\`224x300\`). Digits inside identifiers such as \`top-1\`, \`ResNet-50\`, and
\`DINOv2\` are not checked, except that \`ResNet-101\` and \`ResNet101\` fail when the
quote names \`ResNet-18\` or \`ResNet18\`; the numbers checked are the ones the reader
sees (a link counts as its label; an unlabeled link counts as its target); citation years such as \`(Shukla et al., 2018)\` are not checked.
A \`[!conflict]\` callout holds a statement and two quote and source pairs from
two different sources; each quote is checked the same way, and each number of
the statement must occur in one of the two quotes. The source's \`sha256_text\`
is recomputed, and a source that does not match fails its facts.
A line that starts like \`[!fact…]\` or \`[!conflict…]\` but does not parse (also an
indented, nested, or listed one), an unknown status, a missing or duplicate block ID, an unresolved
source link or heading, a missing quote, and a missing number are findings,
and any finding exits 1. A flagged fact is listed with its reason and does not
fail; a superseded fact is skipped. The report counts facts by status and the
facts that were fully checked. A code fence that is never closed gives a warning,
not a failure. The lint is necessary, not sufficient: it cannot
see swapped numbers, negation, or a real quote that does not support the fact.
Read-only; works with Obsidian closed.
Do NOT use to check a source's own text -- no agent edits a captured source.`,
  arguments: [
    {
      name: "paths",
      variadic: true,
      help: "One or more note names or vault-relative paths.",
    },
  ],
  options: {
    ...vaultOption("Which registered vault to check."),
    json: { type: "boolean", help: "Print JSON instead of a readable summary." },
  },
  exampleOutput: `{"notes": ["knowledge/macaquefaces.md"], "facts": 2, "conflicts": 0,
 "by_status": {"drafted": 0, "checked": 1, "verified": 0, "superseded": 0, "flagged": 1},
 "fully_checked": 0,
 "findings": [{"path": "knowledge/macaquefaces.md", "line": 5, "claim": "fact-macaquefaces-size",
   "code": "number-not-in-quote", "message": "\\"6280\\" in the fact does not occur in the quote"}],
 "flagged": [{"path": "knowledge/macaquefaces.md", "line": 12, "claim": null,
   "reason": "source not captured"}]}`,
  example: "llmos claims lint knowledge/macaquefaces.md --json",
  run(values, context) {
    const model = context.model(context.root(vaultName(values)));
    const given = values.paths;
    if (!Array.isArray(given)) throw new UsageError("paths must be a list of notes");
    const report = lintClaims(
      model,
      given.map((path) => model.resolveNote(path)),
    );
    const exitCode = report.findings.length > 0 ? 1 : 0;
    return values.json ? { json: report, exitCode } : { text: claimsSummary(report), exitCode };
  },
};

const dailyGetOrCreate: Command = {
  name: "daily get-or-create",
  summary:
    "Print today's daily note as JSON, creating it from the daily template if it is missing.",
  description: `Use when an agent needs today's daily note before appending a thought --
idempotent, so calling this repeatedly in one day never recreates it.
Requires Obsidian to be running only when the note is missing (the app
expands the template); exits 3 then if it is not.
Do NOT use when you want the last several days' notes -- use \`recent\`.`,
  arguments: [],
  options: vaultOption('Must be "llmos" -- daily helpers are an llmOS-profile feature.'),
  exampleOutput: `{"name": "2026-07-17", "path": "/vault/daily/2026-07-17.md",
 "properties": {"categories": ["[[Reviews]]"]}, "body": "# 2026-07-17\\n..."}`,
  example: "llmos daily get-or-create",
  run(values, context) {
    const root = llmosOnly(vaultName(values), context);
    return { json: fileJson(root, ensureDaily(root, context)) };
  },
};

const dailyAppendThought: Command = {
  name: "daily append-thought",
  summary: "Append `text` under today's daily note's `## Thoughts` heading.",
  description: `Use when an agent has a lesson, an open question, or a decision to record
for the day. Writes the file directly (atomically), so it works with
Obsidian closed when today's note exists; a missing note is first created
from the daily template, which needs the running app (exit 3 otherwise).
Do NOT use when writing the \`## Projects\` block -- that section is
machine-owned; this command refuses (non-zero exit) rather than touch it,
whether \`text\` contains marker syntax or the note has no marker.`,
  arguments: [{ name: "text", help: "Thought prose to append under `## Thoughts`." }],
  options: vaultOption('Must be "llmos" -- daily helpers are an llmOS-profile feature.'),
  exampleOutput: "Appended to: daily/2026-07-17.md",
  example: 'llmos daily append-thought "TIL obsidian-cli has no heading-targeted append."',
  run(values, context) {
    const root = llmosOnly(vaultName(values), context);
    const text = str(values, "text");
    refuseMarkerSyntax(text);
    const daily = ensureDaily(root, context);
    appendThought(root, daily, text);
    return { text: `Appended to: ${daily}` };
  },
};

const dailyRecent: Command = {
  name: "daily recent",
  summary: "Print the last `n` daily notes' frontmatter and body as JSON, most recent first.",
  description: `Use when starting a weekly-synthesis pass and needing the last N days'
content and properties in one headless call. Works with Obsidian closed.
Do NOT use when you need today's note created if it is absent -- use
\`get-or-create\`; this command only reads what already exists.`,
  arguments: [],
  options: {
    n: {
      type: "integer",
      default: 7,
      metavar: "N",
      help: "Number of most recent daily notes to read.",
    },
    ...vaultOption('Must be "llmos" -- daily helpers are an llmOS-profile feature.'),
  },
  exampleOutput: `[{"name": "2026-07-17", "path": "/vault/daily/2026-07-17.md",
  "properties": {"categories": ["[[Reviews]]"]}, "body": "# 2026-07-17\\n..."}]`,
  example: "llmos daily recent --n 7",
  run(values, context) {
    const model = context.model(llmosOnly(vaultName(values), context));
    const notes = readRecentDailies(model, count(values, "n", 0));
    return { json: notes.map((note) => noteJson(model, note)) };
  },
};

const dailyActivity: Command = {
  name: "daily activity",
  summary: "Write the machine-owned `## Projects` block of daily notes from GitHub activity.",
  description: `Use when the nightly job (or you, by hand) refreshes the \`## Projects\`
block of yesterday's and today's daily notes. It fetches the activity of the
repositories of the projects it monitors with \`gh\`, asks one model call for
the summary, and writes between the \`llmos-activity\` markers. A failed day
writes nothing, and the first failure stops the run with exit 1. The
projects it monitors are those whose folder name matches a repository of one
of the GitHub owners in \`github_owners\` of \`~/.config/llmos/config.json\`.
Do NOT use when you want to add a thought to a note -- use
\`daily append-thought\`; the block is machine-owned.`,
  arguments: [],
  options: {
    root: {
      type: "string",
      metavar: "ROOT",
      help: "Vault root. Default: $LLMOS_ROOT, then the llmOS config file.",
    },
    date: {
      type: "string",
      metavar: "YYYY-MM-DD",
      help: "Process only this date (default: yesterday and today, Los Angeles time). A --date run does not set the run record on categories/Reviews.md.",
    },
    push: {
      type: "boolean",
      help: "Commit the notes this run wrote, rebase on the upstream, and push.",
    },
  },
  exampleOutput: `2026-07-16: updated
2026-07-17: unchanged (hash match, no model call)`,
  example: "llmos daily activity --date 2026-07-16",
  async run(values) {
    const given = optionalStr(values, "date");
    const date = given === undefined ? undefined : parseDay(given);
    if (date === null) throw new UsageError(`invalid --date ${given}`);
    // Imported here: the digest module is large and only this verb uses it.
    const { runDigest } = await import("./digest.ts");
    const run = runDigest({ root: optionalStr(values, "root"), date, push: values.push === true });
    const text = run.lines.join("\n");
    return run.error === undefined
      ? { text }
      : { ...(text ? { text } : {}), stderr: `${run.error}\n`, exitCode: 1 };
  },
};

const doctorCommand: Command = {
  name: "doctor",
  summary: "Check this host's llmOS prerequisites (read-only).",
  description: `Use when setting up a host, or when an agent cannot reach the vault: it
checks the vault root, Obsidian, qmd, the MCP server, the plugin hooks, and
the agent configs on this host. Prints PASS or FAIL per check and a REPAIR
command after each failure; exits 0 only when all pass.
Do NOT use when you want to change anything -- it never repairs.`,
  arguments: [],
  options: {},
  exampleOutput: `PASS vault-root: /vault
FAIL qmd-index: llmOS.md is stale or unindexed
  REPAIR: llmos reindex`,
  example: "llmos doctor",
  async run(_values, context) {
    const { doctor } = await import("./doctor.ts");
    const { lines, exitCode } = await doctor(context.env);
    return { text: lines.join("\n"), exitCode };
  },
};

const auditCommand: Command = {
  name: "audit",
  summary: "Check every llmOS note against the property contract (read-only).",
  description: `Use when checking the frontmatter of a whole vault against the llmOS
property contract, such as before a release. Prints each violation and
exits 1, or prints how many notes passed.
Do NOT use when you want to check one note -- use \`check\`.`,
  arguments: [],
  options: {
    root: {
      type: "string",
      metavar: "PATH",
      help: "The vault to audit. Default: the configured llmOS root.",
    },
  },
  exampleOutput: "metadata audit passed: 412 notes",
  example: "llmos audit --root ~/notes/vault",
  async run(values, context) {
    const given = optionalStr(values, "root");
    const root = given === undefined ? context.root("llmos") : realpathSync(resolve(given));
    const { collectErrors } = await import("./schema.ts");
    const { errors, checked } = collectErrors(context.model(root));
    if (errors.length > 0) return { text: errors.join("\n"), exitCode: 1 };
    return { text: `metadata audit passed: ${checked} notes` };
  },
};

/** The search mode of `--semantic` and `--hybrid`; hybrid includes vector retrieval, so it wins. */
export function searchMode(values: Values): SearchMode {
  if (values.hybrid === true) return "hybrid";
  return values.semantic === true ? "semantic" : "keyword";
}

/** A searcher that opens the qmd store for each search and closes it, as a one-off command does. */
function localSearcher(location: QmdLocation): Searcher {
  return async (query, options) => {
    const store = await openQmd(location, false);
    try {
      return await search(store, query, options);
    } finally {
      await store.close();
    }
  };
}

const searchCommand: Command = {
  name: "search",
  summary:
    "Search a qmd collection for notes: keyword by default, --semantic for vector search, --hybrid for qmd's full pipeline.",
  description: `Use when an agent needs notes about a topic and does not know their names.
Searches the qmd index through the qmd SDK, the same index the \`qmd\`
command uses. Three modes; times are for an M-series Mac:
- keyword (default): BM25 on the query's words. No model, tens of
  milliseconds. Best when you know words the note uses.
- --semantic: vector similarity with the embedding model. About 0.8 s,
  plus about 2 s to load the model on the first call in a process. Finds
  notes by meaning when the words differ.
- --hybrid: qmd's full pipeline: query expansion, keyword and vector
  retrieval, and reranking, with three models. About 13 to 22 s per query
  with the models loaded, and up to 35 s when it loads them. Use it only
  when the other modes miss. It includes vector retrieval, so --semantic
  adds nothing to it.
Semantic and hybrid search see only embedded notes; \`health\` counts the
notes that still need \`reindex\`.
Do NOT use when you know the note -- use \`read\` or \`neighbors\`.`,
  arguments: [{ name: "query", help: "What to search for." }],
  options: {
    semantic: { type: "boolean", help: "Vector search with the embedding model." },
    hybrid: {
      type: "boolean",
      help: "qmd's full pipeline: query expansion, keyword and vector retrieval, reranking.",
    },
    collection: {
      type: "string",
      default: "llmos",
      metavar: "NAME",
      help: "qmd collection to search.",
    },
    limit: { type: "integer", default: 10, metavar: "N", help: "Maximum number of results." },
  },
  exampleOutput: `[{"path": "knowledge/qmd index.md",
  "title": "qmd index", "score": 0.91, "line": 12,
  "snippet": "..."}]`,
  example: 'llmos search "qmd index" --limit 5',
  async run(values, context) {
    const query = str(values, "query");
    const options = {
      collection: str(values, "collection"),
      limit: count(values, "limit", 1),
      mode: searchMode(values),
    };
    const location = qmdLocation(context.env);
    if (!existsSync(location.dbPath)) {
      throw new Error(`no qmd index at ${location.dbPath}; add the collection with qmd first`);
    }
    return {
      json: await viaService(context.env, localSearcher(location), { start: false })(
        query,
        options,
      ),
    };
  },
};

const SCOPE_OPTIONS: Record<string, OptionSpec> = {
  project: {
    type: "string",
    metavar: "NAME",
    help: "Vault project folder under projects/ whose memory to use. Wins over --workspace.",
  },
  workspace: {
    type: "string",
    metavar: "PATH",
    help:
      "Folder of the session: the vault project of its Git repository, else personal. " +
      "Default: the current folder.",
  },
};

/** The memory scope of `--project`, else of `--workspace` (default: the current folder). */
function scopeOf(values: Values, root: string): MemoryScope {
  const project = optionalStr(values, "project");
  if (project !== undefined) return projectScope(root, project);
  return memoryScope(root, resolve(optionalStr(values, "workspace") ?? "."));
}

const memoryScopeCommand: Command = {
  name: "memory scope",
  summary: "Print which project's shared memory a session uses, and its index path.",
  description: `Use when an agent or plugin must know where shared project memory lives
(ADR-0020) before it reads or writes it. A workspace inside a Git repository
whose name matches a folder under \`projects/\` uses that project, by the
session-start hook's rule; any other workspace uses \`personal\`.
\`index_text\` is the index as the session-start hook loads it: at most
${MAX_INDEX_LINES} lines and ${MAX_INDEX_BYTES} bytes, marked when cut, or null.`,
  arguments: [],
  options: { ...SCOPE_OPTIONS, ...vaultOption('Must be "llmos".') },
  exampleOutput: `{"project": "llmos-tools", "dir": "projects/llmos-tools/memory",
  "index": "projects/llmos-tools/memory/MEMORY.md",
  "index_path": "/Users/me/vault/projects/llmos-tools/memory/MEMORY.md",
  "index_text": "# Memory index\\n\\n- [Use uv](use-uv.md) — ..."}`,
  example: "llmos memory scope --workspace ~/code/llmos-tools",
  run(values, context) {
    const root = llmosOnly(vaultName(values), context);
    const scope = scopeOf(values, root);
    const indexPath = join(root, scope.index);
    return {
      json: { ...scope, index_path: indexPath, index_text: readMemoryIndex(root, indexPath) },
    };
  },
};

const memorySave: Command = {
  name: "memory save",
  summary: "Save one shared memory: a topic note and its MEMORY.md index line.",
  description: `Use when an agent learns a fact that another agent or a later session can
use: a user preference, a correction, a project constraint, or a pointer to
an outside resource. Writes \`<dir>/<name>.md\` with the frontmatter Claude
Code writes (\`name\`, \`description\`, \`metadata.node_type: memory\`,
\`metadata.type\`, \`metadata.modified\`) and adds or replaces its line in
\`MEMORY.md\`. Saving a name again replaces that memory's body and keeps its
other properties. Fails, and writes nothing, when the index would pass ${MAX_INDEX_LINES}
lines or ${MAX_INDEX_BYTES} bytes, because agents load only that much: merge or
forget memories first.
Then updates the qmd keyword index (no model), so \`memory search --keyword\`
finds the memory at once. A running llmOS service also embeds it in the
background; a save never starts the service or loads a model.
Do NOT use for durable knowledge notes -- those follow the vault's
authoring.md.`,
  arguments: [
    { name: "name", help: "Lowercase slug of the memory and its file name, such as use-uv." },
    { name: "description", help: "One line that says when the memory is relevant." },
    {
      name: "body",
      help: "The fact; for feedback and project, add **Why:** and **How to apply:**.",
    },
  ],
  options: {
    type: {
      type: "string",
      choices: MEMORY_TYPES,
      default: "project",
      help: "user (who the user is), feedback (how to work), project (ongoing work), or reference (a pointer).",
    },
    title: {
      type: "string",
      metavar: "TEXT",
      help: "Link text of the index line. Default: the name with spaces.",
    },
    ...SCOPE_OPTIONS,
    ...vaultOption('Must be "llmos".'),
  },
  exampleOutput: `{"path": "projects/llmos-tools/memory/use-uv.md",
  "index": "projects/llmos-tools/memory/MEMORY.md", "created": true}`,
  example:
    'llmos memory save use-uv "Run Python through uv" "Use uv run, never bare python." --type feedback',
  async run(values, context) {
    const root = llmosOnly(vaultName(values), context);
    const input: MemoryInput = {
      name: str(values, "name"),
      description: str(values, "description"),
      body: str(values, "body"),
      type: str(values, "type") as MemoryType,
    };
    const title = optionalStr(values, "title");
    if (title !== undefined) input.title = title;
    const saved = saveMemory(root, scopeOf(values, root), input, new Date());
    const warning = await afterMemoryWrite(context.env);
    return warning === null ? { json: saved } : { json: saved, stderr: `${warning}\n` };
  },
};

const memorySearch: Command = {
  name: "memory search",
  summary: "Search one project's shared memory notes; semantic by default.",
  description: `Use when an agent needs the memories that match a task and the index lines
do not settle it. Searches the \`memory\` qmd collection (the top-level notes
of every \`projects/*/memory/\` folder) and keeps the topic notes of the
scope's memory folder, not the index. While that collection is missing, it
searches the \`llmos\` collection instead; \`doctor\` says how to add it.
Semantic search needs the embedding model. A running llmOS service
(\`service serve\`) has it loaded, so the search takes about 1 s; without
the service, the first call in a process loads the model. --keyword needs no
model and finds a saved memory at once. Semantic search finds it after the
service embeds it in the background, or after \`reindex\`.`,
  arguments: [{ name: "query", help: "What to search for." }],
  options: {
    keyword: { type: "boolean", help: "BM25 keyword search instead of vector search." },
    limit: { type: "integer", default: 5, metavar: "N", help: "Maximum number of results." },
    ...SCOPE_OPTIONS,
    ...vaultOption('Must be "llmos".'),
  },
  exampleOutput: `[{"path": "projects/llmos-tools/memory/use-uv.md",
  "title": "use-uv", "score": 0.82, "line": 9, "snippet": "..."}]`,
  example: 'llmos memory search "python packaging" --project llmos-tools',
  async run(values, context) {
    const root = llmosOnly(vaultName(values), context);
    const scope = scopeOf(values, root);
    const location = qmdLocation(context.env);
    if (!existsSync(location.dbPath)) {
      throw new Error(`no qmd index at ${location.dbPath}; add the collection with qmd first`);
    }
    const searcher = viaService(context.env, localSearcher(location), { start: false });
    const hits = await searchMemoryNotes(searcher, scope, str(values, "query"), {
      limit: count(values, "limit", 1),
      mode: values.keyword === true ? "keyword" : "semantic",
    });
    return { json: hits };
  },
};

const memoryForget: Command = {
  name: "memory forget",
  summary: "Delete one shared memory: its topic note and its MEMORY.md index line.",
  description: `Use when a memory is wrong or no longer true. Removes \`<dir>/<name>.md\`
and its index line; fails when neither exists.
Updates the qmd keyword index too, as \`memory save\` does.
Do NOT use to change a memory -- \`memory save\` with the same name replaces it.`,
  arguments: [{ name: "name", help: "The memory's name (its file name without .md)." }],
  options: { ...SCOPE_OPTIONS, ...vaultOption('Must be "llmos".') },
  exampleOutput: `{"path": "projects/llmos-tools/memory/use-uv.md",
  "index": "projects/llmos-tools/memory/MEMORY.md"}`,
  example: "llmos memory forget use-uv --project llmos-tools",
  async run(values, context) {
    const root = llmosOnly(vaultName(values), context);
    const forgotten = forgetMemory(root, scopeOf(values, root), str(values, "name"));
    const warning = await afterMemoryWrite(context.env);
    return warning === null ? { json: forgotten } : { json: forgotten, stderr: `${warning}\n` };
  },
};

const reindexCommand: Command = {
  name: "reindex",
  summary: "Update, embed, and clean up the qmd index for a collection.",
  description: `Use after vault changes, or when \`health\` reports qmd gaps, to bring
search up to date. Runs the steps of \`qmd update\` (scan the collection's
files), \`qmd embed\` (vectors for new or changed documents; loads the
embedding model when there is work), and \`qmd cleanup\` (orphaned vectors,
inactive documents, LLM cache, FTS compaction, vacuum; this step covers
the whole index) through the qmd SDK. Two embeds never run at once: a
second one fails while another process holds qmd's embed lock.
A reindex of \`llmos\` also scans the \`memory\` collection when it exists
("memory" in the report; null otherwise), because memory notes change outside
\`llmos memory\` too.
--no-embed runs only the scan: keyword search is current at once and no
model loads; "embed" and "cleanup" are null. The plugin's Stop hook runs it
after each turn that changed the vault. Run plain \`reindex\` by hand to
embed; \`health\` reports documents that still need embedding.
Do NOT use when you only want to search -- use \`search\`.`,
  arguments: [],
  options: {
    collection: {
      type: "string",
      default: "llmos",
      metavar: "NAME",
      help: "qmd collection to update and embed.",
    },
    "no-embed": {
      type: "boolean",
      help: "Only scan the collection's files; skip embedding and cleanup.",
    },
  },
  exampleOutput: `{"update": {"indexed": 1, "updated": 2, "unchanged": 890, "removed": 0, "skipped": 0},
 "memory": {"indexed": 0, "updated": 1, "unchanged": 40, "removed": 0, "skipped": 0},
 "embed": {"docsProcessed": 3, "chunksEmbedded": 9, "errors": 0, "durationMs": 2100},
 "cleanup": {"cacheCount": 4, "orphanedVectors": 120, "inactiveDocs": 1, "orphanedContent": 1}}`,
  example: "llmos reindex",
  async run(values, context) {
    const location = qmdLocation(context.env);
    const store = await openQmd(location, true);
    try {
      const embed = values["no-embed"] !== true;
      return { json: await reindex(store, location.dbPath, str(values, "collection"), { embed }) };
    } finally {
      await store.close();
    }
  },
};

const serviceServe: Command = {
  name: "service serve",
  summary: "Run the llmOS service: one warm qmd model set for every agent session on this host.",
  description: `Use rarely by hand: \`llmos mcp\` starts the service itself when it finds
none, detached, and its search tools and the search verbs then use it. The
service keeps the qmd models loaded, so a semantic search takes about 1 s
instead of a cold model load, and it embeds new shared memories in the
background after \`memory save\`. It listens on the Unix socket
\`service.sock\` in the llmOS state folder (\`$XDG_STATE_HOME/llmos\`, else
\`~/.local/state/llmos\`; the folder is mode 0700, the socket 0600), and
speaks one JSON request per line (docs/service.md). It stops after 30
minutes without a request. Only one service runs per host: a second
\`service serve\` exits at once with exit code 0 and says so. Foreground; it
returns when the service stops. \`LLMOS_SERVICE=off\` stops every client from
using or starting it; \`LLMOS_SERVICE_IDLE_MS\` changes the idle limit.
Do NOT use to stop the service -- send it SIGTERM (\`service status\` gives
the pid).`,
  arguments: [],
  options: {},
  exampleOutput: "the llmOS service stopped",
  example: "llmos service serve",
  async run(_values, context) {
    const { ServiceInUse, serveService } = await import("./service.ts");
    let running: Awaited<ReturnType<typeof serveService>>;
    try {
      running = await serveService({ env: context.env });
    } catch (error) {
      if (error instanceof ServiceInUse) return { text: error.message };
      throw error;
    }
    const stop = (): void => void running.close();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await running.done;
    return { text: "the llmOS service stopped" };
  },
};

const serviceStatusCommand: Command = {
  name: "service status",
  summary: "Say whether the llmOS service runs, and what it holds.",
  description: `Use to see whether the llmOS service runs on this host, which qmd models it
holds in memory, and whether it embeds in the background. Starts nothing.
\`running\` is false when no service listens on the socket.`,
  arguments: [],
  options: {},
  exampleOutput: `{"running": true, "socket": "/home/me/.local/state/llmos/service.sock",
 "pid": 4242, "started_at": "2026-11-19T10:00:00.000Z", "index": "/home/me/.cache/qmd/index.sqlite",
 "requests": 12, "idle_stop_ms": 1800000,
 "models": {"embed": true, "rerank": false, "generate": false}, "embedding": false}`,
  example: "llmos service status",
  async run(_values, context) {
    const status = await serviceStatus(context.env);
    const socket = servicePaths(context.env).socket;
    return {
      json: status === null ? { running: false, socket } : { running: true, socket, ...status },
    };
  },
};

const configSetRoot: Command = {
  name: "config set-root",
  summary: "Validate a vault root and write it to the llmOS config file.",
  description: `Use when setting up a host (setup-llmos) and the llmOS root is not
configured. The path must exist and contain both \`.obsidian/\` and
\`AGENTS.md\`; otherwise nothing is written and this exits 1. The root is
stored as a real path in \`vault_root\` of \`~/.config/llmos/config.json\`,
which every llmOS command reads when \`$LLMOS_ROOT\` is not set. Other keys
in the file, such as \`github_owners\`, are kept. The vault can be at any
path, such as the root of its own Git repository.
Do NOT use when \`$LLMOS_ROOT\` is set for the session -- it wins over the
config file.`,
  arguments: [{ name: "path", help: "The llmOS vault folder." }],
  options: {},
  exampleOutput: "wrote /home/me/.config/llmos/config.json -> /home/me/notes/vault",
  example: "llmos config set-root ~/notes/vault",
  run(values, context) {
    const home = context.env.HOME || homedir();
    const given = str(values, "path");
    const expanded = given === "~" || given.startsWith("~/") ? join(home, given.slice(1)) : given;
    const absolute = resolve(expanded);
    const root = validated(existsSync(absolute) ? realpathSync(absolute) : absolute);
    const config = join(home, ".config", "llmos", "config.json");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, `${JSON.stringify({ ...readConfig(config), vault_root: root })}\n`);
    return { text: `wrote ${config} -> ${root}` };
  },
};

const mcp: Command = {
  name: "mcp",
  summary: "Serve the llmOS vault tools to an agent over MCP on stdin and stdout.",
  description: `Use when an agent harness starts the llmOS MCP server -- the plugin's
\`.mcp.json\` starts it in every session through \`dist/mcp.js\`. Read tools:
read, neighbors, subgraph, check, health, search. Write tools:
daily_append_thought, file_inbox, set_property; each stamps \`updated\` on
the notes it changes. It serves only the llmOS vault and its
\`llmos\` qmd collection, and refuses any note whose real path is outside the
vault. One vault model stays loaded (read again when a note file changes),
and so do the search models after the first semantic search. Runs until
stdin closes.
Do NOT use when you want one answer in a shell -- run that verb instead.`,
  arguments: [],
  options: {},
  exampleOutput: "(MCP JSON-RPC messages on stdout until stdin closes)",
  example: "llmos mcp",
  async run(_values, context) {
    // Imported here: the server module imports this registry.
    const { serve } = await import("./mcp.ts");
    await serve(context);
    return {};
  },
};

const docs: Command = {
  name: "docs",
  summary: "Regenerate the vault-cli skill's command reference and verb table from this CLI.",
  description: `Use when a command's help text changes or a command is added -- run this
so \`references/commands.md\` and the skill's verb table match \`--help\`
before committing. A test renders both again and fails when the committed
files are stale.
Do NOT use when you only want to read the help -- run \`<command> --help\`.`,
  arguments: [],
  options: {
    reference: {
      type: "string",
      metavar: "PATH",
      help: "Where to write the full command reference; must be inside the tools folder.",
    },
    skill: {
      type: "string",
      metavar: "PATH",
      help: "The SKILL.md whose verb table is replaced in place; must be inside the tools folder.",
    },
  },
  exampleOutput: "wrote skills/vault-cli/references/commands.md",
  example: "llmos docs",
  run(values) {
    // Both files must be inside this tools folder, checked like a vault write.
    const inTools = (name: string, fallback: string): string =>
      relative(TOOLS, resolve(values[name] === undefined ? fallback : str(values, name)));
    const reference = newTarget(TOOLS, inTools("reference", DEFAULT_REFERENCE_PATH));
    const skill = realTarget(TOOLS, inTools("skill", DEFAULT_SKILL_PATH));
    const skillText = renderSkill(readFileSync(skill, "utf8"), COMMANDS);
    mkdirSync(dirname(reference), { recursive: true });
    writeFileSync(reference, renderReference(COMMANDS));
    writeFileSync(skill, skillText);
    return { text: `wrote ${reference}` };
  },
};

/** Every `llmos` command. */
export const COMMANDS: readonly Command[] = [
  read,
  list,
  check,
  neighbors,
  subgraph,
  health,
  discoverCommand,
  create,
  move,
  append,
  setPropertyCommand,
  removePropertyCommand,
  fileInbox,
  sourceAdd,
  claimsLint,
  dailyGetOrCreate,
  dailyAppendThought,
  dailyRecent,
  dailyActivity,
  searchCommand,
  memoryScopeCommand,
  memorySave,
  memorySearch,
  memoryForget,
  reindexCommand,
  serviceServe,
  serviceStatusCommand,
  mcp,
  configSetRoot,
  doctorCommand,
  auditCommand,
  docs,
];
