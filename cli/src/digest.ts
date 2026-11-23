/**
 * The daily activity digest (`llmos daily activity`): writes the
 * machine-owned `## Projects` block of daily notes.
 *
 * Fetch with `gh` -> hash -> one `opencode run` call -> check that every PR
 * and issue is linked with its repository (`checkCompleteness`; an omission
 * gets a new call, up to `SUMMARY_ATTEMPTS` calls) -> atomic write between
 * the `llmos-activity` markers. It is a script, not an agent.
 * It processes yesterday and today
 * (Los Angeles time), or one `--date`. A failed day writes nothing, and the
 * first failure stops the run with a non-zero exit. A run without `--date`
 * that succeeds sets its run record (`DIGEST_PROPERTY` on `DIGEST_NOTE`),
 * so `llmos health` reports the digest when it stops running. With
 * `--push` it then commits the notes it wrote and pushes them (`pushNotes`).
 *
 * It replaced the retired Python digest and keeps its contract: the markers
 * from `daily.ts`, the block hash (`blockHash`; the same `gh` output gives
 * the same hash), the rule that a failed day writes nothing, and the
 * daily-note format. `test/contract/digest.test.ts` pins this contract with
 * a snapshot. Two differences from the Python digest are intended:
 *
 * - a PR merged in one repository no longer hides a PR with the same number
 *   opened in another (`fetchActivity`), so on such a day the block and its
 *   hash differ from the Python digest's;
 * - the summary must link each PR and issue with its repository and number
 *   (its GitHub URL), where Python accepted any `#N`, so one `#N` no longer
 *   counts for two repositories (`checkCompleteness`). This is internal: the
 *   block hash is unchanged.
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
 *   marker, in that order, and only the text between them changes. The
 *   write reads the note again after the model call, so text that another
 *   writer added during the call stays (`.agents/skills/verify-daily-digest`
 *   model-checks this).
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
import { type Day, isoDate, MARKER_END, MARKER_START, parseDay } from "./daily.ts";
import { MissingFrontmatter, parse, UnsupportedFrontmatter } from "./frontmatter.ts";
import { add, commit, hasStaged, mainCheckout, publish } from "./git.ts";
import { DIGEST_NOTE, DIGEST_PROPERTY } from "./health.ts";
import { DAILY_DIR, DAILY_NOTE, SHARED_MEMORY_PATH, TEMPLATES_DIR } from "./layout.ts";
import { DEFAULT_CONFIG_PATH, readConfig, VaultRootError, vaultRoot } from "./root.ts";
import { run } from "./run.ts";
import { readText } from "./vault.ts";
import { recordRun } from "./write.ts";

export const LOCAL_TZ = "America/Los_Angeles";
export const MODEL = "github-copilot/claude-haiku-5.5";
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
/** A `gh` list or search call: seconds on a good network, and the digest waits on it. */
const GH_TIMEOUT_MS = 60_000;
const SUMMARY_ATTEMPTS = 3;
const DAY_MS = 86_400_000;

export class DigestError extends Error {
  override name = "DigestError";
}

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
function dayRange(day: Day): string {
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
  const result = run(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    const stderr = result.timedOut
      ? `timed out after ${GH_TIMEOUT_MS / 1000} s`
      : result.stderr.toString().trim();
    throw new DigestError(`gh ${args.slice(0, 3).join(" ")} failed: ${stderr}`);
  }
  return parseGhJson(decodeUtf8(result.stdout, "gh"));
}

/**
 * The GitHub users and organizations whose repositories the digest monitors:
 * `github_owners` in the llmOS config file, a list of names.
 */
export function githubOwners(configPath: string = DEFAULT_CONFIG_PATH): string[] {
  const owners = readConfig(configPath).github_owners;
  if (
    !Array.isArray(owners) ||
    owners.length === 0 ||
    !owners.every((owner) => typeof owner === "string" && owner !== "")
  ) {
    throw new DigestError(
      `set "github_owners" in ${configPath} to the GitHub users and organizations ` +
        `whose repositories the digest monitors, such as ["octocat"]`,
    );
  }
  return owners;
}

/** Map lowercased repo name -> every `owner/name` with that name across `owners`. */
export function listOrgRepos(owners: readonly string[], gh: Gh = runGh): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const org of owners) {
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
 * a repository of one of the configured owners has its folder name.
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
function fetchActivity(day: Day, repos: string[], gh: Gh = runGh): Activity {
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
  // A PR is identified by its repository and number: a PR merged in one
  // repository must not hide a PR with the same number opened in another.
  // (The Python digest compared numbers alone.)
  const prKey = (pr: Item): string =>
    JSON.stringify([
      (pr.repository as Item | undefined)?.nameWithOwner ?? null,
      field(pr, "number"),
    ]);
  const mergedKeys = new Set(merged.map(prKey));
  return {
    merged_prs: merged,
    opened_prs: opened.filter((pr) => !mergedKeys.has(prKey(pr))),
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

/** A PR or issue the summary must cite. */
export interface Reference {
  /** `owner/repo#number`, which names it across repositories. */
  name: string;
  repo: string;
  number: string;
  /** The `url` gh returned, which the prompt asks the model to link. */
  url: string;
}

/**
 * The PRs and issues the summary must cite, sorted by name. A reference
 * includes its repository: two repositories can have the same number on
 * one day, and a bare `#N` would count for both.
 */
export function expectedReferences(grouped: Grouped): Reference[] {
  const refs = new Map<string, Reference>();
  for (const bucket of grouped.values()) {
    for (const [repo, kinds] of bucket.repos) {
      for (const [kind, list] of kinds) {
        if (kind === "commits") continue;
        for (const item of list) {
          const number = String(field(item, "number"));
          const name = `${repo}#${number}`;
          refs.set(name, { name, repo, number, url: String(field(item, "url")) });
        }
      }
    }
  }
  return [...refs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Whether `prose` links the reference: a GitHub pull or issue URL of its
 * repository (owner and name in any case) and number, with no digit after
 * the number, so `/pull/4` does not count as `/pull/45`.
 */
function cites(prose: string, ref: Reference): boolean {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const url = `github\\.com/${literal(ref.repo)}/(?:pull|issues)/${literal(ref.number)}(?![0-9])`;
  return new RegExp(url, "i").test(prose);
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
  const required = expectedReferences(grouped)
    .map((ref) => `[#${ref.number}](${ref.url})`)
    .join(", ");
  return (
    `${TRANSFORM_INSTRUCTIONS}\n\n` +
    `GitHub activity for ${isoDate(day)}, grouped by project. Write one \`### <Title>\` ` +
    "section per project (use the `title` field), in the given order. Under each, write a " +
    "markdown bullet list — one bullet per distinct piece of work, never one large " +
    "paragraph. Cite every PR and issue inline as a markdown link to its `url`, " +
    "e.g. [#12](url); cite two with the same number in different repositories separately. " +
    `Every one of these links MUST appear in your output: ${required}. ` +
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
    if (type === "error") {
      throw new DigestError(`opencode run emitted an error: ${opencodeError(line).slice(0, 500)}`);
    }
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
 * The message of the first `error` event in `opencode run --format json`
 * output, or "". opencode reports a failed model call there, not on stderr.
 * Some errors carry it in `error.data.message` and others in `error.message`
 * (in opencode 2.2, an unknown agent or an unavailable model), so read both.
 */
export function opencodeError(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        error?: { message?: unknown; data?: { message?: unknown } };
      };
      const message =
        event?.type === "error" ? (event.error?.data?.message ?? event.error?.message) : undefined;
      if (typeof message === "string") return message;
    } catch {}
  }
  return "";
}

/**
 * One `opencode run` call as the tool-less `OPENCODE_AGENT`, from an empty
 * scratch folder, so no project config or instructions apply.
 *
 * `--standalone` gives the call its own server. Without it, `opencode run`
 * attaches to the background `opencode serve --service` when one is running,
 * and that server never sees `OPENCODE_CONFIG_CONTENT` or the scratch folder,
 * so it fails with `Agent not found: "llmos-digest"`.
 */
export function summarize(grouped: Grouped, day: Day, opencodeBin = "opencode"): string {
  const scratch = mkdtempSync(join(tmpdir(), "llmos-digest-"));
  try {
    const argv = [
      "run",
      "--standalone",
      "--agent",
      OPENCODE_AGENT,
      "--format",
      "json",
      "--model",
      MODEL,
    ];
    const result = run([opencodeBin, ...argv], {
      cwd: scratch,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_CONFIG) },
      stdin: new TextEncoder().encode(summaryPrompt(grouped, day)),
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: OPENCODE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.timedOut) {
      throw new DigestError(`opencode run timed out after ${OPENCODE_TIMEOUT_MS / 1000} s`);
    }
    if (result.exitCode !== 0) {
      const reason = [result.stderr.toString().trim(), opencodeError(result.stdout.toString())]
        .filter((part) => part !== "")
        .join("; ");
      throw new DigestError(`opencode run failed: ${reason.slice(0, 500)}`);
    }
    return parseOpencodeOutput(decodeUtf8(result.stdout, "opencode run"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- Publishing -----------------------------------------------------------------------

// The digest runs from a timer, not a hook, so its git calls may take longer.
const GIT_LOCAL_TIMEOUT_MS = 30_000;
const GIT_TIMEOUTS = { fetch: 60_000, merge: 60_000, push: 60_000 };
const MERGE_MESSAGE = "daily activity: merge the remote main";

/** What the digest may push: daily notes, its run note, and shared project memory. */
function pushable(path: string): boolean {
  return DAILY_NOTE.test(path) || path === DIGEST_NOTE || SHARED_MEMORY_PATH.test(path);
}

/**
 * Commit `paths` (vault-relative) and publish them to `origin/main` with
 * git.ts `publish`, the same flow as the memory sync: fetch, fast-forward or
 * merge without the work tree, then push the one commit it checked. Only
 * `paths` are committed, so other edits in the checkout stay as they are.
 * The push refuses while an unpushed commit touches anything but daily
 * notes, the run note, and shared memory, so a private note the user
 * committed stays local. A conflict with the remote fails the run and changes
 * nothing. With no change in `paths`, it still publishes, so a push that
 * failed on an earlier night is retried. It takes no sync lock: the
 * `verify-memory-sync` model shows that the sync's rules hold with the
 * digest running beside it.
 */
export function pushNotes(root: string, paths: string[], message: string): void {
  const opened = mainCheckout(root, process.env, GIT_LOCAL_TIMEOUT_MS);
  if (!opened.ok) throw new DigestError(`cannot push the vault: ${opened.reason}`);
  const { checkout } = opened;
  const inRepo = paths.map((path) =>
    checkout.vaultRel === "." ? path : `${checkout.vaultRel}/${path}`,
  );
  if (inRepo.length > 0) {
    const addError = add(checkout, inRepo);
    if (addError) throw new DigestError(`git add failed: ${addError}`);
    const staged = hasStaged(checkout, inRepo);
    if (typeof staged === "object") throw new DigestError(`git diff failed: ${staged.error}`);
    const commitError = staged ? commit(checkout, inRepo, message) : null;
    if (commitError) throw new DigestError(`git commit failed: ${commitError}`);
  }
  const published = publish(checkout, {
    allowed: pushable,
    mergeMessage: MERGE_MESSAGE,
    timeouts: GIT_TIMEOUTS,
  });
  if (!("failed" in published)) return;
  if (published.failed === "check") {
    const others = published.paths.slice(0, 3).join(", ");
    throw new DigestError(`not pushing: unpushed commits also touch ${others}; push them by hand`);
  }
  throw new DigestError(`${published.failed} failed, the notes stay local: ${published.reason}`);
}

// --- The note ----------------------------------------------------------------------------

/** Write `<!--` as `&lt;!--`, so the text can hold no marker and no HTML comment. */
export function neutralize(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

export function checkCompleteness(prose: string, expected: Reference[]): void {
  const missing = expected.filter((ref) => !cites(prose, ref)).map((ref) => ref.name);
  if (missing.length > 0) {
    throw new DigestError(`summary omitted references: ${missing.join(", ")}`);
  }
}

/**
 * The model's summary, once it links every reference. The model sometimes
 * drops one link out of many, and the same prompt then links all of them,
 * so an omission gets a new call, up to `SUMMARY_ATTEMPTS` calls in all.
 */
function completeSummary(grouped: Grouped, day: Day, summarizer: Summarizer): string {
  const expected = expectedReferences(grouped);
  for (let attempt = 1; ; attempt++) {
    const prose = summarizer(grouped, day);
    try {
      checkCompleteness(neutralize(prose), expected);
      return prose;
    } catch (error) {
      if (attempt === SUMMARY_ATTEMPTS) throw error;
      console.error(`${isoDate(day)}: ${(error as Error).message}; calling the model again`);
    }
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
  const template = readText(join(root, TEMPLATES_DIR, "daily-note.md"));
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
  /** The GitHub owners whose repositories are monitored (`githubOwners`). */
  owners: readonly string[];
  gh?: Gh;
  opencodeBin?: string;
  /** Replaces the model call (tests). */
  summarize?: Summarizer;
}

/** Run the pipeline for one day and return its outcome. Throws and writes nothing on failure. */
export function processDay(day: Day, root: string, options: ProcessOptions): string {
  const gh = options.gh ?? runGh;
  const [monitored, unseen] = readProjects(root, listOrgRepos(options.owners, gh));
  const repos = monitored.flatMap((project) => project.repos);
  const grouped = groupByProject(fetchActivity(day, repos, gh), monitored);
  const notePath = join(root, DAILY_DIR, `${isoDate(day)}.md`);

  if (grouped.size === 0) {
    return existsSync(notePath) ? "silent (note untouched)" : "silent (no note created)";
  }

  const hash = blockHash(grouped, unseen);
  const text = existsSync(notePath) ? readText(notePath) : "";
  if (existingHash(text) === hash) return "unchanged (hash match, no model call)";

  const prose = completeSummary(grouped, day, (g, d) =>
    options.summarize ? options.summarize(g, d) : summarize(g, d, options.opencodeBin),
  );
  const block = buildBlock(prose, unseen, hash);
  // The model call takes minutes. A thought or a new note written meanwhile
  // must survive, so replace the block in the note as it is now.
  if (existsSync(notePath)) {
    atomicWrite(notePath, replaceBlock(readText(notePath), block));
    return "updated";
  }
  mkdirSync(dirname(notePath), { recursive: true });
  atomicWrite(notePath, newNoteText(day, root, block));
  return "created";
}

export interface DigestRun {
  /** One `<date>: <outcome>` line per processed day, also for the days before a failure. */
  lines: string[];
  /** What the run prints on stderr when it fails. */
  error?: string;
}

/** Run the digest for yesterday and today, or for `date`. Never throws and never prints. */
export function runDigest(options: { root?: string; date?: Day; push?: boolean }): DigestRun {
  const lines: string[] = [];
  try {
    const root = options.root || vaultRoot();
    const owners = githubOwners();
    const today = parseDay(localDate(Date.now())) as Day;
    const only = options.date;
    const days = only === undefined ? [today - 1, today] : [only];
    const written: string[] = [];
    for (const day of days) {
      const outcome = processDay(day, root, { owners });
      lines.push(`${isoDate(day)}: ${outcome}`);
      if (outcome === "created" || outcome === "updated") {
        written.push(join(DAILY_DIR, `${isoDate(day)}.md`));
      }
    }
    if (only === undefined) {
      try {
        recordRun(root, DIGEST_NOTE, DIGEST_PROPERTY, isoDate(today));
      } catch (error) {
        throw new DigestError(
          `cannot record the run on ${DIGEST_NOTE}: ${(error as Error).message}`,
        );
      }
      written.push(DIGEST_NOTE);
    }
    if (options.push) {
      pushNotes(root, written, `daily activity: ${days.map(isoDate).join(", ")}`);
    }
    return { lines };
  } catch (error) {
    if (error instanceof DigestError || error instanceof VaultRootError) {
      return { lines, error: `llmos daily activity: ${error.message}` };
    }
    return {
      lines,
      error: error instanceof Error ? (error.stack ?? String(error)) : String(error),
    };
  }
}
