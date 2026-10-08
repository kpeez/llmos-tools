/**
 * The `llmos-vault` commands. Each one keeps the command name and JSON
 * output shape of the retired Python CLI. Reads answer from one vault
 * model; writes are headless file writes (`write.ts`), except `move` and
 * `create --template`, which need the running Obsidian app.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { checkNote } from "./authoring.ts";
import { type Command, type Context, type OptionSpec, UsageError, type Values } from "./cli.ts";
import { DAILY_DIR, type Day, parseDay, readRecentDailies, refuseMarkerSyntax } from "./daily.ts";
import { renderReference, renderSkill } from "./docs.ts";
import { isClean, qmdSection, summary, vaultHealth } from "./health.ts";
import { destinationProperties } from "./inbox.ts";
import { runObsidian } from "./obsidian.ts";
import { detectProvider } from "./provider.ts";
import {
  indexedPaths,
  openQmd,
  qmdLocation,
  reindex,
  type SearchMode,
  search,
  unembeddedCount,
} from "./qmd.ts";
import { validated } from "./root.ts";
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

const TOOLS = resolve(import.meta.dir, "..");
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
  return { vault: { type: "string", default: "llmos", choices: ["llmos", "second-vault"], help } };
}

// Handlers are also called without the command line (the MCP server), so
// they check their values themselves instead of trusting `parseValues`.

/** A string value. */
function str(values: Values, name: string): string {
  const value = values[name];
  if (typeof value !== "string") throw new UsageError(`${name} must be a string`);
  return value;
}

/** The `--vault` name: llmos or second-vault. */
function vaultName(values: Values): string {
  const vault = str(values, "vault");
  if (vault !== "llmos" && vault !== "second-vault") {
    throw new UsageError(`vault must be llmos or second-vault, got '${vault}'`);
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

const read: Command = {
  name: "read",
  summary: "Print one note's frontmatter and body as JSON.",
  description: `Use when an agent needs a note's current content or properties -- to
inspect before editing, or to script a decision on a property value. Works
with Obsidian closed.
Do NOT use when you need every note in the vault -- use \`list\`, which walks
the vault once instead of resolving names one at a time.`,
  arguments: [{ name: "note", help: "Note basename (wikilink-style) or vault-relative path." }],
  options: vaultOption("Which registered vault to read from."),
  exampleOutput: `{"name": "alpha", "path": "/vault/notes/alpha.md",
 "properties": {"topics": ["gardening"]}, "body": "# Alpha\\n..."}`,
  example: "llmos-vault read alpha --vault llmos",
  run(values, context) {
    const model = context.model(context.root(vaultName(values)));
    return { json: noteJson(model, model.resolveNote(str(values, "note"))) };
  },
};

const list: Command = {
  name: "list",
  summary: "Print every note in the vault with its frontmatter and body as JSON.",
  description: `Use when an agent needs to enumerate or scan all notes -- e.g. finding
every note missing a property before scripting a bulk decision.
Do NOT use when you already know which note you want -- use \`read\`.`,
  arguments: [],
  options: vaultOption("Which registered vault to enumerate."),
  exampleOutput: `[{"name": "alpha", "path": "/vault/notes/alpha.md",
  "properties": {"topics": ["gardening"]}, "body": "# Alpha\\n..."}]`,
  example: "llmos-vault list --vault llmos",
  run(values, context) {
    const model = context.model(context.root(vaultName(values)));
    return { json: model.notes.map((note) => noteJson(model, note)) };
  },
};

const check: Command = {
  name: "check",
  summary: "Review one note for unlinked references to existing vault notes.",
  description: `Reports body links separately from frontmatter links, plus the first
unlinked .md reference to each known target. Exits 1 when findings need
review, 0 otherwise. Never rewrites content; works with Obsidian closed.
This is a conservative authoring aid: code examples, missing files, and
ambiguous filenames are ignored. A clean result does not certify useful
connections, link resolution, Base formulas, or rendering. Use \`neighbors\`
and Obsidian for those checks.`,
  arguments: [{ name: "note", help: "Note basename or vault-relative path." }],
  options: vaultOption("Which registered vault to check."),
  exampleOutput: `{"path": "notes/alpha.md", "body_links": [], "property_links": ["Project"],
 "findings": [{"code": "unlinked-note", "line": 7, "target": "notes/beta",
               "message": "Existing note reference \\"beta.md\\": link to \\"notes/beta\\" ..."}]}`,
  example: "llmos-vault check projects/study/manuscript/README.md --vault llmos",
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
  example: "llmos-vault neighbors alpha --vault llmos",
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
  example: "llmos-vault subgraph alpha --vault llmos --depth 2",
  run(values, context) {
    const model = context.model(context.root(vaultName(values)));
    return { json: model.subgraph(str(values, "note"), count(values, "depth", 0)) };
  },
};

const health: Command = {
  name: "health",
  summary:
    "Report vault hygiene: orphans, dead-ends, unresolved wikilinks, schema violations, stale inbox items, and qmd index gaps.",
  description: `Use when starting a vault-maintenance pass -- e.g. after a vault change --
to see every hygiene defect in one headless call. Each section degrades
independently: when qmd has no index or no such collection, the report
carries a notice instead of failing. Works with Obsidian closed. Exits 1 if
any section has findings, 0 on a clean vault, so cron can branch on it.
llmOS schema-violation checks run only for --vault llmos. qmd_unembedded
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
  exampleOutput: `{"orphans": ["gamma"], "dead_ends": ["beta"],
 "unresolved_links": [{"referrer": "alpha", "target": "ghost"}],
 "schema_violations": [], "stale_inbox": [], "qmd_gaps": [], "qmd_unembedded": 0,
 "qmd_notice": null}`,
  example: "llmos-vault health --vault llmos --json",
  async run(values, context) {
    const vault = vaultName(values);
    const collection = str(values, "qmd-collection");
    const model = context.model(context.root(vault));
    const qmd = await qmdIndexState(context, collection);
    const report = {
      ...vaultHealth(model, {
        profile: vault === "llmos" ? "llmos" : "core",
        staleAfterDays: count(values, "stale-after-days", 0),
        today: today(context),
      }),
      ...qmdSection(model, qmd.paths, collection, qmd.unembedded),
    };
    const exitCode = isClean(report) ? 0 : 1;
    return values.json ? { json: report, exitCode } : { text: summary(report), exitCode };
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
file; edit the note instead.`,
  arguments: [{ name: "name", help: 'Vault-relative note path (".md" appended if missing).' }],
  options: {
    ...vaultOption("Which registered vault to create the note in."),
    content: { type: "string", metavar: "TEXT", help: "Initial content." },
    template: { type: "string", metavar: "NAME", help: "Name of a vault template to apply." },
  },
  exampleOutput: "Created: projects/agent-toolbox.md",
  example: "llmos-vault create projects/agent-toolbox --template project --vault llmos",
  run(values, context) {
    const root = context.root(vaultName(values));
    const name = str(values, "name");
    const target = name.endsWith(".md") ? name : `${name}.md`;
    const content = values.content as string | undefined;
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
  exampleOutput: "Moved: notes/alpha.md -> archive/alpha.md",
  example: "llmos-vault move alpha archive/alpha.md --vault llmos",
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
  example: 'llmos-vault append alpha "One more thought." --vault llmos',
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
written as a string. Writes the file directly (atomically), so it works
with Obsidian closed. A note whose frontmatter cannot be read is left
untouched (exit 1).
\`authors\` is append-only: setting it adds \`value\` to the existing list
instead of overwriting it.
Do NOT use when rewriting \`created\` -- it is immutable and this call
exits with an error.`,
  arguments: [
    { name: "note", help: "Note name (wikilink-style resolution) or vault-relative path." },
    { name: "key", help: "Property name." },
    { name: "value", help: "Property value to set (or add to `authors`)." },
  ],
  options: vaultOption("Which registered vault the note lives in."),
  exampleOutput: "Set: status = active",
  example: "llmos-vault set-property alpha status active --vault llmos",
  run(values, context) {
    const root = context.root(vaultName(values));
    const note = context.model(root).resolveNote(str(values, "note"));
    const key = propertyKey(values);
    const value = propertyValue(values);
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
with an error.`,
  arguments: [
    { name: "note", help: "Note name (wikilink-style resolution) or vault-relative path." },
    { name: "key", help: "Property name to remove." },
  ],
  options: vaultOption("Which registered vault the note lives in."),
  exampleOutput: "Removed: status",
  example: "llmos-vault remove-property alpha status --vault llmos",
  run(values, context) {
    const root = context.root(vaultName(values));
    const note = context.model(root).resolveNote(str(values, "note"));
    const key = propertyKey(values);
    const removed = removeProperty(root, note.path, key);
    return { text: removed ? `Removed: ${key}` : `Not set: ${key}` };
  },
};

const fileInbox: Command = {
  name: "file-inbox",
  summary:
    "File an inbox note: move it via obsidian-cli, stamp its destination properties and authors, and record it in today's daily note.",
  description: `Use when an inbox capture has a real home -- the sanctioned ritual so an
agent never files a note half-way. The steps run in order, and a failed
step stops the rest: move the note (needs the running Obsidian app; exits 3
when it is not running), add the \`categories\`/\`project\` properties the
destination implies, add the acting provider to \`authors\`, and append a
line under \`## Thoughts\` in today's daily note. Safe to re-run: a note
already at \`destination\` is not moved again, and existing properties are
kept. Only the move needs Obsidian.
Do NOT use when \`destination\`'s top-level folder is not \`knowledge\`,
\`projects\`, \`sources\`, or \`archive\` -- this exits with an error before
any move is attempted.`,
  arguments: [
    {
      name: "note",
      help: "Note name (wikilink-style resolution) or vault-relative path of the inbox item.",
    },
    { name: "destination", help: 'Vault-relative destination path (".md" appended if missing).' },
  ],
  options: vaultOption('Must be "llmos" -- inbox filing is an llmOS-profile feature.'),
  exampleOutput: "Filed: capture-1 -> knowledge/some-note.md",
  example: "llmos-vault file-inbox capture-1 knowledge/some-note.md",
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
    stampProperties(root, relative, stamps, detectProvider(context.env));
    const daily = ensureDaily(root, context);
    appendThought(root, daily, `Filed \`${name}\` from inbox -> \`${relative}\`.`);
    return { text: `Filed: ${name} -> ${relative}` };
  },
};

const sourceAdd: Command = {
  name: "source add",
  summary:
    "Capture an arXiv paper or web page into a frozen source folder: raw HTML, figures, defuddle text, and a manifest.",
  description: `Use when an inbox item is a source worth keeping as the original: an arXiv
paper or an open-access web page. The capture goes to \`sources/<slug>/\`
and holds \`raw.html\`, \`assets/\` (the images of the captioned figures,
taken from the raw HTML), and \`source.md\`, whose frontmatter is the manifest
(\`origin\`, \`source_id\`, \`retrieved\`, \`licence\`, \`converter\`,
\`sha256_raw\`, \`sha256_text\`, \`figures\`). An arXiv paper is read from its
\`arxiv.org/html/<id>\` version, and an ID without a version is pinned to
the version fetched (\`arxiv:1811.00743v2\`). \`source\` accepts an arXiv ID,
an arXiv or web URL, or an inbox note that holds only a URL. The inbox note
stays where it is. Writes the files directly, so it works with Obsidian
closed. Only public http and https hosts are requested (no IP addresses,
no local or private networks, at most five redirects, at most 50 MB a
file). A figure image from a non-public host, with a failing status, or of a
non-image type is skipped and named in the output. A source already
captured is not fetched or changed: the command says so and exits 0. An ID without a version counts any captured version of
that paper as captured; ask for \`<id>vN\` to capture a newer one. No agent
edits a source folder afterwards.
Do NOT use when the item is a PDF, or an arXiv paper without an HTML
version: there is no converter yet, so this exits 1 and leaves the item
where it is.`,
  arguments: [
    {
      name: "source",
      help: "An arXiv ID (1811.00743 or 1811.00743v2), a URL, or a vault-relative inbox note that holds only a URL.",
    },
  ],
  options: vaultOption('Must be "llmos" -- sources are an llmOS-profile feature.'),
  exampleOutput: "Captured: arxiv:1811.00743v2 -> sources/arxiv-1811.00743v2 (4 figures)",
  example: "llmos-vault source add 1811.00743",
  async run(values, context) {
    const root = llmosOnly(vaultName(values), context);
    const result = await captureSource(root, str(values, "source"), context);
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
  exampleOutput: `{"name": "2026-07-17", "path": "/vault/reviews/daily/2026-07-17.md",
 "properties": {"categories": ["[[Reviews]]"]}, "body": "# 2026-07-17\\n..."}`,
  example: "llmos-vault daily get-or-create",
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
  exampleOutput: "Appended to: reviews/daily/2026-07-17.md",
  example: 'llmos-vault daily append-thought "TIL obsidian-cli has no heading-targeted append."',
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
  exampleOutput: `[{"name": "2026-07-17", "path": "/vault/reviews/daily/2026-07-17.md",
  "properties": {"categories": ["[[Reviews]]"]}, "body": "# 2026-07-17\\n..."}]`,
  example: "llmos-vault daily recent --n 7",
  run(values, context) {
    const model = context.model(llmosOnly(vaultName(values), context));
    const notes = readRecentDailies(model, count(values, "n", 0));
    return { json: notes.map((note) => noteJson(model, note)) };
  },
};

/** The search mode of `--semantic` and `--hybrid`; hybrid includes vector retrieval, so it wins. */
export function searchMode(values: Values): SearchMode {
  if (values.hybrid === true) return "hybrid";
  return values.semantic === true ? "semantic" : "keyword";
}

const searchCommand: Command = {
  name: "search",
  summary:
    "Search a qmd collection for notes: keyword by default, --semantic for vector search, --hybrid for qmd's full pipeline.",
  description: `Use when an agent needs notes about a topic and does not know their names.
Searches the qmd index through the qmd SDK, the same index the \`qmd\`
command uses. Three modes; times are for mac-host (an M-series Mac):
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
  exampleOutput: `[{"path": "projects/llmos/adrs/0012-port-tools-to-typescript-on-bun.md",
  "title": "Port the tools to TypeScript on Bun", "score": 0.91, "line": 12,
  "snippet": "..."}]`,
  example: 'llmos-vault search "qmd index" --limit 5',
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
    const store = await openQmd(location, false);
    try {
      return { json: await search(store, query, options) };
    } finally {
      await store.close();
    }
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
 "embed": {"docsProcessed": 3, "chunksEmbedded": 9, "errors": 0, "durationMs": 2100},
 "cleanup": {"cacheCount": 4, "orphanedVectors": 120, "inactiveDocs": 1, "orphanedContent": 1}}`,
  example: "llmos-vault reindex",
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

const configSetRoot: Command = {
  name: "config set-root",
  summary: "Validate a vault root and write it to the llmOS config file.",
  description: `Use when setting up a host (setup-llmos) and the llmOS root is not
configured. The path must exist and contain both \`.obsidian/\` and
\`AGENTS.md\`; otherwise nothing is written and this exits 1. The root is
stored as a real path in \`~/.config/llmos/config.json\`, which every
llmOS command reads when \`$LLMOS_ROOT\` is not set.
Do NOT use when \`$LLMOS_ROOT\` is set for the session -- it wins over the
config file.`,
  arguments: [{ name: "path", help: "The llmOS vault folder." }],
  options: {},
  exampleOutput: "wrote /home/me/.config/llmos/config.json -> /home/me/code/llmos/llmOS",
  example: "llmos-vault config set-root ~/code/llmos/llmOS",
  run(values, context) {
    const home = context.env.HOME || homedir();
    const given = str(values, "path");
    const expanded = given === "~" || given.startsWith("~/") ? join(home, given.slice(1)) : given;
    const absolute = resolve(expanded);
    const root = validated(existsSync(absolute) ? realpathSync(absolute) : absolute);
    const config = join(home, ".config", "llmos", "config.json");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, `${JSON.stringify({ vault_root: root })}\n`);
    return { text: `wrote ${config} -> ${root}` };
  },
};

const mcp: Command = {
  name: "mcp",
  summary: "Serve the llmOS vault tools to an agent over MCP on stdin and stdout.",
  description: `Use when an agent harness starts the llmOS MCP server -- the plugin's
\`.mcp.json\` starts it in every session through \`dist/mcp.js\`. Read tools:
read, neighbors, subgraph, check, health, search. Write tools:
daily_append_thought, file_inbox, set_property; each stamps \`updated\` and
\`authors\` on the notes it changes. It serves only the llmOS vault and its
\`llmos\` qmd collection, and refuses any note whose real path is outside the
vault. One vault model stays loaded (read again when a note file changes),
and so do the search models after the first semantic search. Runs until
stdin closes.
Do NOT use when you want one answer in a shell -- run that verb instead.`,
  arguments: [],
  options: {},
  exampleOutput: "(MCP JSON-RPC messages on stdout until stdin closes)",
  example: "llmos-vault mcp",
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
  example: "llmos-vault docs",
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

/** Every `llmos-vault` command. */
export const COMMANDS: readonly Command[] = [
  read,
  list,
  check,
  neighbors,
  subgraph,
  health,
  create,
  move,
  append,
  setPropertyCommand,
  removePropertyCommand,
  fileInbox,
  sourceAdd,
  dailyGetOrCreate,
  dailyAppendThought,
  dailyRecent,
  searchCommand,
  reindexCommand,
  mcp,
  configSetRoot,
  docs,
];
