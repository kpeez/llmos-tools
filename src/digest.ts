#!/usr/bin/env bun
/**
 * The daily activity digest (`llmos-daily-activity`): writes the
 * machine-owned `## Projects` block of daily notes.
 *
 * Fetch with `gh` -> hash -> one `opencode run` call -> check that every PR
 * and issue reference appears -> atomic write between the `llmos-activity`
 * markers. It is a script, not an agent. It processes yesterday and today
 * (Los Angeles time), or one `--date`. A failed day writes nothing, and the
 * first failure stops the run with a non-zero exit.
 *
 * It replaces the Python `llmos_vault.daily_activity`. The contract the two
 * share: the markers from `daily.ts`, the block hash (`blockHash`; the same
 * `gh` output gives the same hash), the rule that a failed day writes
 * nothing, and the daily-note format. `test/differential/digest.ts` checks
 * this contract against the Python version.
 *
 * Untrusted text: PR and issue titles and bodies come from GitHub and reach
 * the model, so:
 *
 * - the model runs as an opencode agent with every permission denied, so it
 *   has no tools (no shell, files, or network) and can only return text;
 * - output with any event besides one text answer fails the day;
 * - `<!--` in the model's text or a project title is written as `&lt;!--`,
 *   so no marker (and no HTML comment) can appear inside the block;
 * - a note is rewritten only when it has exactly one start and one end
 *   marker, in that order, and only the text between them changes.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { MARKER_END, MARKER_START } from "./daily.ts";
import { MissingFrontmatter, parse, UnsupportedFrontmatter } from "./frontmatter.ts";
import { VaultRootError, vaultRoot } from "./root.ts";
import { readText } from "./vault.ts";

export const LOCAL_TZ = "America/Los_Angeles";
export const MODEL = "opencode-go/deepseek-v4-flash";
export const ORGS = ["kpeez", "linux-host-ucdavis"] as const;
export const TRANSFORM_INSTRUCTIONS =
  "You are a deterministic text transformer inside a script. You receive JSON of one " +
  "day's GitHub activity grouped by project and emit only GitHub-flavored markdown. " +
  "No preamble, no code fences around the whole output, and no tool use. Do not access " +
  "the filesystem or network, and do no work beyond transforming the supplied JSON.";

/** The opencode agent for the model call: every permission denied, so no tools. */
export const OPENCODE_AGENT = "llmos-digest";
export const OPENCODE_CONFIG = {
  agent: {
    [OPENCODE_AGENT]: {
      mode: "primary",
      description: "Transforms the activity digest JSON into markdown. No tools.",
      permission: { "*": "deny" },
    },
  },
};
const OPENCODE_TIMEOUT_MS = 600_000;
const DAY_MS = 86_400_000;

export class DigestError extends Error {
  override name = "DigestError";
}

/** A calendar day as a count of days since 1970-01-01. */
export type Day = number;

export interface Project {
  slug: string;
  title: string;
  repos: string[];
}

/** One `gh` call: the arguments after `gh`, returning the parsed JSON output. */
export type Gh = (args: string[]) => unknown;

type Item = Record<string, unknown>;
const ACTIVITY_KINDS = [
  "merged_prs",
  "opened_prs",
  "issues_created",
  "issues_closed",
  "commits",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type Activity = Record<ActivityKind, Item[]>;
/** Project slug -> title and repo -> activity kind -> items, in first-seen order. */
export type Grouped = Map<string, { title: string; repos: Map<string, Map<string, Item[]>> }>;
export type Summarizer = (grouped: Grouped, day: Day) => string;

// --- Days -----------------------------------------------------------------------

export function isoDate(day: Day): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Parse `YYYY-MM-DD`; null when it is not a real date. */
export function parseDay(text: string): Day | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(ms) || isoDate(ms / DAY_MS) !== text ? null : ms / DAY_MS;
}

const LOCAL_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: LOCAL_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const LOCAL_OFFSET = new Intl.DateTimeFormat("en-US", {
  timeZone: LOCAL_TZ,
  timeZoneName: "longOffset",
});

/** The Los Angeles date (`YYYY-MM-DD`) at an instant. */
function localDate(ms: number): string {
  return LOCAL_DATE.format(new Date(ms));
}

/** The Los Angeles UTC offset at an instant, as `-07:00`. */
function offsetAt(ms: number): string {
  const name = LOCAL_OFFSET.formatToParts(new Date(ms)).find(
    (part) => part.type === "timeZoneName",
  )?.value;
  if (name === "GMT") return "+00:00";
  if (!name || !/^GMT[+-]\d{2}:\d{2}$/.test(name)) {
    throw new DigestError(`unexpected time zone offset ${name}`);
  }
  return name.slice(3);
}

function offsetMs(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  return sign * (Number(offset.slice(1, 3)) * 3_600_000 + Number(offset.slice(4, 6)) * 60_000);
}

/**
 * The offset of a Los Angeles wall time (given as milliseconds read as UTC).
 * When the wall time is repeated or skipped, the offset before the change.
 */
function offsetForWall(wall: number): string {
  const before = offsetAt(wall - DAY_MS);
  if (offsetAt(wall - offsetMs(before)) === before) return before;
  const after = offsetAt(wall + DAY_MS);
  return offsetAt(wall - offsetMs(after)) === after ? after : before;
}

/** The local day as a `gh` date range with explicit offsets (PDT or PST). */
export function dayRange(day: Day): string {
  const iso = isoDate(day);
  const start = day * DAY_MS;
  const end = start + DAY_MS - 1000;
  return `${iso}T00:00:00${offsetForWall(start)}..${iso}T23:59:59${offsetForWall(end)}`;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Whether a `gh` timestamp falls on `day` in Los Angeles. A missing one does not. */
function onDay(timestamp: unknown, day: Day): boolean {
  if (timestamp === undefined || timestamp === null || timestamp === "") return false;
  const match = typeof timestamp === "string" ? TIMESTAMP.exec(timestamp) : null;
  const ms = match ? Date.parse(`${match[1]}${(match[2] ?? "").slice(0, 4)}${match[3]}`) : NaN;
  if (Number.isNaN(ms)) {
    throw new DigestError(`gh returned an unexpected timestamp: ${JSON.stringify(timestamp)}`);
  }
  return localDate(ms) === isoDate(day);
}

// --- The block hash ---------------------------------------------------------------

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

/**
 * Parse `gh` JSON output. Every number must be a plain safe integer: the
 * block hash is defined over integers, and `gh` returns no other numbers for
 * the requested fields.
 */
export function parseGhJson(text: string): unknown {
  const reviver: Reviver = (_key, value, context) => {
    if (typeof value !== "number") return value;
    const source = context?.source;
    if (source === undefined) {
      throw new DigestError("this runtime does not expose JSON number source text");
    }
    if (!(/^-?(0|[1-9][0-9]*)$/.test(source) && Number.isSafeInteger(value))) {
      throw new DigestError(`gh output has a number that is not a safe integer: ${source}`);
    }
    return value;
  };
  return (JSON.parse as (text: string, reviver: Reviver) => unknown)(text, reviver);
}

/** Order strings by code point (UTF-16 order differs for astral characters). */
function byCodePoint(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done || q.done) return p.done ? (q.done ? 0 : -1) : 1;
    const diff = (p.value.codePointAt(0) as number) - (q.value.codePointAt(0) as number);
    if (diff !== 0) return diff;
  }
}

function hashString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const short: Record<number, string> = {
      34: '\\"',
      92: "\\\\",
      10: "\\n",
      13: "\\r",
      9: "\\t",
      8: "\\b",
      12: "\\f",
    };
    if (short[code]) out += short[code];
    else if (code >= 0x20 && code <= 0x7e) out += value[i];
    else out += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}

/**
 * The canonical JSON the block hash is taken over: keys sorted by code
 * point, `", "` and `": "` separators, and every character outside printable
 * ASCII escaped as `\uXXXX` per UTF-16 code unit. This is the text of
 * Python's `json.dumps(value, sort_keys=True, ensure_ascii=True)`, which
 * defined the hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return hashString(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new DigestError(`cannot hash the number ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(", ")}]`;
  if (typeof value === "object") {
    const entries: [string, unknown][] =
      value instanceof Map ? [...value.entries()] : Object.entries(value);
    entries.sort(([a], [b]) => byCodePoint(a, b));
    return `{${entries.map(([key, item]) => `${hashString(key)}: ${canonicalJson(item)}`).join(", ")}}`;
  }
  throw new DigestError(`cannot hash a ${typeof value}`);
}

/** Hash everything the block renders, so a coverage change regenerates it. */
export function blockHash(grouped: Grouped, unseen: Project[]): string {
  const payload = { activity: grouped, unseen: unseen.map((project) => project.slug) };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

// --- Fetch and group ------------------------------------------------------------------

function items(value: unknown, what: string): Item[] {
  if (!Array.isArray(value)) throw new DigestError(`gh ${what} did not return a JSON list`);
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new DigestError(`gh ${what} returned a list item that is not an object`);
    }
  }
  return value as Item[];
}

function field(item: Item, key: string): unknown {
  if (!Object.hasOwn(item, key)) throw new DigestError(`gh item has no "${key}" field`);
  return item[key];
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DigestError(`${what} output is not valid UTF-8`);
  }
}

export function runGh(args: string[]): unknown {
  const result = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new DigestError(`gh ${args.slice(0, 3).join(" ")} failed: ${stderr}`);
  }
  return parseGhJson(decodeUtf8(result.stdout, "gh"));
}

/** Map lowercased repo name -> every `owner/name` with that name across `ORGS`. */
export function listOrgRepos(gh: Gh = runGh): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const org of ORGS) {
    const args = ["repo", "list", org, "--limit", "1000", "--json", "nameWithOwner"];
    for (const repo of items(gh(args), "repo list")) {
      const full = field(repo, "nameWithOwner");
      if (typeof full !== "string" || !full.includes("/")) {
        throw new DigestError(`gh repo list returned ${JSON.stringify(full)}`);
      }
      const name = full.slice(full.indexOf("/") + 1).toLowerCase();
      names.set(name, [...(names.get(name) ?? []), full]);
    }
  }
  return names;
}

function entries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Return [monitored, active but unseen] projects from the landing notes
 * `projects/<slug>/<slug>.md`, ordered by slug. A project is monitored when
 * a repository in `ORGS` has its folder name (vault ADR 0009).
 */
export function readProjects(
  root: string,
  orgRepos: Map<string, string[]>,
): [Project[], Project[]] {
  const monitored: Project[] = [];
  const unseen: Project[] = [];
  const slugs = entries(join(root, "projects"))
    .filter((slug) => isDirectory(join(root, "projects", slug)))
    .sort(byCodePoint);
  for (const slug of slugs) {
    const path = `projects/${slug}/${slug}.md`;
    if (!existsSync(join(root, path))) continue;
    // One unreadable landing page must not stop the digest for every other
    // project; its repository is simply not monitored today.
    let properties: Record<string, unknown>;
    let body: string;
    try {
      ({ properties, body } = parse(readText(join(root, path))));
    } catch (error) {
      const unreadable =
        error instanceof MissingFrontmatter ||
        error instanceof UnsupportedFrontmatter ||
        (error as { code?: string }).code === "ERR_ENCODING_INVALID_ENCODED_DATA";
      if (!unreadable) throw error;
      console.error(`skipping ${path}: ${(error as Error).message}`);
      continue;
    }
    if (properties.status !== "active") continue;
    const repos = orgRepos.get(slug.toLowerCase()) ?? [];
    if (repos.length > 1) {
      throw new DigestError(`project "${slug}" matches several repos: ${repos.join(", ")}`);
    }
    const title = /^# (.+)$/m.exec(body)?.[1]?.trim() ?? slug;
    (repos.length > 0 ? monitored : unseen).push({ slug, title, repos: [...repos] });
  }
  if (monitored.length === 0) {
    throw new DigestError("no monitored projects found -- no active project matches a repo");
  }
  return [monitored, unseen];
}

/** Four `gh` search calls. Every repo must be reachable; a 404 is a hard failure. */
export function fetchActivity(day: Day, repos: string[], gh: Gh = runGh): Activity {
  const repoFlags = repos.flatMap((repo) => ["--repo", repo]);
  const range = dayRange(day);
  const search = (kind: string, qualifier: string, fields: string) =>
    items(
      gh(["search", kind, ...repoFlags, qualifier, range, "--json", fields, "--limit", "100"]),
      `search ${kind}`,
    );
  const prFields = "number,title,body,url,repository,state";
  const merged = search("prs", "--merged-at", prFields);
  const opened = search("prs", "--created", prFields);
  const issues = search(
    "issues",
    "--updated",
    "number,title,body,url,repository,state,createdAt,closedAt",
  );
  const commits = search("commits", "--author-date", "sha,commit,repository,url");
  const mergedNumbers = new Set(merged.map((pr) => field(pr, "number")));
  return {
    merged_prs: merged,
    opened_prs: opened.filter((pr) => !mergedNumbers.has(field(pr, "number"))),
    issues_created: issues.filter((issue) => onDay(issue.createdAt, day)),
    issues_closed: issues.filter((issue) => onDay(issue.closedAt, day)),
    commits,
  };
}

export function groupByProject(activity: Activity, projects: Project[]): Grouped {
  const repoToProject = new Map(
    projects.flatMap((project) => project.repos.map((repo) => [repo, project] as const)),
  );
  const grouped: Grouped = new Map();
  for (const kind of ACTIVITY_KINDS) {
    for (const item of activity[kind]) {
      // gh search prs/issues -> nameWithOwner; gh search commits -> fullName
      const repository = (item.repository ?? {}) as Item;
      const repo = repository.nameWithOwner || repository.fullName;
      const project = typeof repo === "string" ? repoToProject.get(repo) : undefined;
      if (project === undefined) {
        throw new DigestError(`activity in unmapped repo ${JSON.stringify(repo ?? null)}`);
      }
      let bucket = grouped.get(project.slug);
      if (!bucket) {
        bucket = { title: project.title, repos: new Map() };
        grouped.set(project.slug, bucket);
      }
      let kinds = bucket.repos.get(repo as string);
      if (!kinds) {
        kinds = new Map();
        bucket.repos.set(repo as string, kinds);
      }
      kinds.set(kind, [...(kinds.get(kind) ?? []), item]);
    }
  }
  return grouped;
}

export function expectedReferences(grouped: Grouped): Set<string> {
  const refs = new Set<string>();
  for (const bucket of grouped.values()) {
    for (const kinds of bucket.repos.values()) {
      for (const [kind, list] of kinds) {
        if (kind === "commits") continue;
        for (const item of list) refs.add(`#${field(item, "number")}`);
      }
    }
  }
  return refs;
}

// --- The model call -------------------------------------------------------------------

function plain(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]));
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

/** The prompt for the one model call. */
export function summaryPrompt(grouped: Grouped, day: Day): string {
  const required = [...expectedReferences(grouped)].sort().join(", ");
  return (
    `${TRANSFORM_INSTRUCTIONS}\n\n` +
    `GitHub activity for ${isoDate(day)}, grouped by project. Write one \`### <Title>\` ` +
    "section per project (use the `title` field), in the given order. Under each, write a " +
    "markdown bullet list — one bullet per distinct piece of work, never one large " +
    "paragraph. Cite every PR and issue inline as a markdown link, " +
    `e.g. [#12](url). Every one of these references MUST appear in your output: ${required}. ` +
    "Summarize commits briefly; do not list every commit. Base the prose on the `body` " +
    "fields, not just titles. Output only the sections.\n\n" +
    JSON.stringify(plain(grouped), null, 1)
  );
}

/**
 * The single final answer from `opencode run --format json` output. Any
 * other event (a tool call, an error) fails the day.
 */
export function parseOpencodeOutput(stdout: string): string {
  const answers: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new DigestError("opencode run emitted malformed JSON");
    }
    const { type, part } = (event ?? {}) as { type?: unknown; part?: Record<string, unknown> };
    if (typeof event !== "object" || Array.isArray(event) || typeof type !== "string") {
      throw new DigestError("opencode run emitted an unsupported event");
    }
    if (type === "step_start" || type === "step_finish") continue;
    if (type !== "text")
      throw new DigestError(`opencode run emitted unsupported event type: ${type}`);
    if (part?.type !== "text" || typeof part.text !== "string") {
      throw new DigestError("opencode run emitted a malformed text event");
    }
    const text = part.text.trim();
    if (text === "") throw new DigestError("opencode run emitted an empty final assistant message");
    answers.push(text);
  }
  if (answers.length !== 1) {
    throw new DigestError(
      `opencode run emitted ${answers.length} final assistant messages; expected one`,
    );
  }
  return answers[0] as string;
}

/**
 * One `opencode run` call as the tool-less `OPENCODE_AGENT`, from an empty
 * scratch folder, so no project config or instructions apply.
 */
export function summarize(grouped: Grouped, day: Day, opencodeBin = "opencode"): string {
  const scratch = mkdtempSync(join(tmpdir(), "llmos-digest-"));
  try {
    const argv = ["run", "--agent", OPENCODE_AGENT, "--format", "json", "--model", MODEL];
    const result = Bun.spawnSync([opencodeBin, ...argv], {
      cwd: scratch,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_CONFIG) },
      stdin: new TextEncoder().encode(summaryPrompt(grouped, day)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: OPENCODE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.exitedDueToTimeout) {
      throw new DigestError(`opencode run timed out after ${OPENCODE_TIMEOUT_MS / 1000} s`);
    }
    if (result.exitCode !== 0) {
      throw new DigestError(
        `opencode run failed: ${result.stderr.toString().trim().slice(0, 500)}`,
      );
    }
    return parseOpencodeOutput(decodeUtf8(result.stdout, "opencode run"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- The note ----------------------------------------------------------------------------

/** Write `<!--` as `&lt;!--`, so the text can hold no marker and no HTML comment. */
export function neutralize(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

export function checkCompleteness(prose: string, expected: Set<string>): void {
  const missing = [...expected].filter((ref) => !prose.includes(ref)).sort();
  if (missing.length > 0) {
    throw new DigestError(`summary omitted references: ${missing.join(", ")}`);
  }
}

export function buildBlock(prose: string, unseen: Project[], hash: string): string {
  const lines = [`${MARKER_START} hash=${hash} -->`, "", neutralize(prose), ""];
  if (unseen.length > 0) {
    const names = unseen.map((project) => `[[${project.slug}|${project.title}]]`).join(", ");
    lines.push(neutralize(`_Not monitored (active, no repository): ${names}_`), "");
  }
  lines.push(MARKER_END);
  return lines.join("\n");
}

const HASH_LINE = new RegExp(
  `${MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} hash=([0-9a-f]{64}) -->`,
);

export function existingHash(text: string): string | null {
  return HASH_LINE.exec(text)?.[1] ?? null;
}

function count(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/**
 * `text` with its block replaced by `block`. A note without markers gets the
 * block under `## Projects` (added at the end if missing). Refuses a note
 * whose markers are not exactly one start followed by one end.
 */
export function replaceBlock(text: string, block: string): string {
  const starts = count(text, MARKER_START);
  const ends = count(text, MARKER_END);
  if (starts === 0 && ends === 0) {
    const heading = "## Projects";
    const at = text.indexOf(heading);
    if (at === -1) return `${text.replace(/\n+$/, "")}\n\n${heading}\n\n${block}\n`;
    const after = at + heading.length;
    return `${text.slice(0, after)}\n\n${block}${text.slice(after)}`;
  }
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new DigestError(
      `note has ${starts} start and ${ends} end llmos-activity markers, ` +
        "not one block -- refusing to write",
    );
  }
  return text.slice(0, start) + block + text.slice(end + MARKER_END.length);
}

export function newNoteText(day: Day, root: string, block: string): string {
  const template = readText(join(root, "templates", "daily-note.md"));
  return replaceBlock(template.replaceAll("{{date:YYYY-MM-DD}}", isoDate(day)), block);
}

/** Write through a temporary file in the same folder and rename it into place. */
function atomicWrite(path: string, content: string): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o7777 : undefined;
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}`);
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

export interface ProcessOptions {
  gh?: Gh;
  opencodeBin?: string;
  /** Replaces the model call (tests). */
  summarize?: Summarizer;
}

/** Run the pipeline for one day and return its outcome. Throws and writes nothing on failure. */
export function processDay(day: Day, root: string, options: ProcessOptions = {}): string {
  const gh = options.gh ?? runGh;
  const [monitored, unseen] = readProjects(root, listOrgRepos(gh));
  const repos = monitored.flatMap((project) => project.repos);
  const grouped = groupByProject(fetchActivity(day, repos, gh), monitored);
  const notePath = join(root, "reviews", "daily", `${isoDate(day)}.md`);

  if (grouped.size === 0) {
    return existsSync(notePath) ? "silent (note untouched)" : "silent (no note created)";
  }

  const hash = blockHash(grouped, unseen);
  const text = existsSync(notePath) ? readText(notePath) : "";
  if (existingHash(text) === hash) return "unchanged (hash match, no model call)";

  const prose = options.summarize
    ? options.summarize(grouped, day)
    : summarize(grouped, day, options.opencodeBin);
  checkCompleteness(neutralize(prose), expectedReferences(grouped));
  const block = buildBlock(prose, unseen, hash);
  if (text) {
    atomicWrite(notePath, replaceBlock(text, block));
    return "updated";
  }
  mkdirSync(dirname(notePath), { recursive: true });
  atomicWrite(notePath, newNoteText(day, root, block));
  return "created";
}

const USAGE = `usage: llmos-daily-activity [-h] [--root ROOT] [--date YYYY-MM-DD]

Write the machine-owned ## Projects block of daily notes.

options:
  -h, --help         show this help message and exit
  --root ROOT        vault root (default: $LLMOS_ROOT, then the llmOS config file)
  --date YYYY-MM-DD  process only this date (default: yesterday and today, Los Angeles time)
`;

/** The command-line entry point. Returns the exit code. */
export function main(argv: string[]): number {
  let values: { root?: string; date?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        date: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    process.stderr.write(`${USAGE}\nllmos-daily-activity: error: ${(error as Error).message}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const only = values.date === undefined ? undefined : parseDay(values.date);
  if (only === null) {
    process.stderr.write(`${USAGE}\nllmos-daily-activity: error: invalid --date ${values.date}\n`);
    return 2;
  }
  try {
    const root = values.root || vaultRoot();
    const today = parseDay(localDate(Date.now())) as Day;
    for (const day of only === undefined ? [today - 1, today] : [only]) {
      console.log(`${isoDate(day)}: ${processDay(day, root)}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof DigestError || error instanceof VaultRootError) {
      console.error(`llmos-daily-activity: ${error.message}`);
    } else {
      console.error(error);
    }
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(Bun.argv.slice(2));
