/**
 * The vault health report: orphans, dead-ends, unresolved wikilinks, schema
 * violations, stale inbox items, and overdue manual jobs, computed from one
 * vault model.
 *
 * Schema violations are the llmOS profile's contract and are skipped for a
 * plain vault, any other `--vault` ("core" profile). The qmd index gaps compare the
 * vault's notes with the paths a qmd collection holds; the caller reads those
 * paths from the qmd store (`qmd.ts`), so this module stays synchronous and
 * never imports qmd.
 *
 * A job leaves its run record in the vault, so every host that syncs the
 * vault sees it (`RUN_RECORDS`): `discover` sets the `discovered` date on
 * `DISCOVER_NOTE`, and the nightly digest sets the `digested` date on
 * `DIGEST_NOTE`. Only the llmOS profile has run records.
 */

import { type Day, parseDay } from "./daily.ts";
import { isInboxDrop, isMemoryNote, TEMPLATES_DIR } from "./layout.ts";
import { categoryHubs, collectErrors, isValidCategory } from "./schema.ts";
import type { Note, UnresolvedLink, VaultModel } from "./vault.ts";

export type Profile = "llmos" | "core";

/**
 * Whether a note carries a valid category (`isValidCategory`). Its category
 * hub lists it through a Base, so it is reachable without a wikilink and is
 * never an orphan. A `categories` value that is not a list is no category.
 */
function hasValidCategory(note: Note, hubs: ReadonlySet<string>): boolean {
  const categories = note.properties.categories;
  return Array.isArray(categories) && categories.some((value) => isValidCategory(value, hubs));
}

/**
 * Whether a note is a template: scaffolding in `categories/templates/`.
 * In the llmos vault such a note is never an orphan or a dead-end, its
 * placeholder links (`{{title}}`) are not unresolved links, and its own links
 * do not count as inbound links. A link to a template still resolves.
 */
function isTemplate(note: Note): boolean {
  return note.path.startsWith(`${TEMPLATES_DIR}/`);
}

/** The note whose `discovered` property records the last `discover` run. */
export const DISCOVER_NOTE = "categories/Knowledge.md";
/** The property of `DISCOVER_NOTE` that holds that day, as `YYYY-MM-DD`. */
export const DISCOVER_PROPERTY = "discovered";
/**
 * How old the last `discover` run may be, in days: the weekly cadence (8)
 * plus 2 days for the git sync between the machines that run it.
 */
export const DISCOVER_MAX_AGE_DAYS = 10;

/** The note whose `digested` property records the last successful nightly digest run. */
export const DIGEST_NOTE = "categories/Reviews.md";
/** The property of `DIGEST_NOTE` that holds that day, as `YYYY-MM-DD`. */
export const DIGEST_PROPERTY = "digested";
/**
 * How old the last digest run may be, in days: the nightly cadence (1) plus
 * 2 days of slack, for a failed nightly push from the host that runs the timer.
 */
export const DIGEST_MAX_AGE_DAYS = 3;

/**
 * How many days after today a recorded date may lie: the host that ran the
 * job and the host that runs `health` can sit in time zones a day apart. A
 * later date is invalid.
 */
export const RUN_RECORD_CLOCK_SKEW_DAYS = 1;

/** A job whose last successful run is a date property on one note. */
export interface RunRecord {
  job: string;
  /** The only command that may set the property. */
  command: string;
  note: string;
  property: string;
  maxAgeDays: number;
}

export const RUN_RECORDS: readonly RunRecord[] = [
  {
    job: "discover",
    command: "llmos-vault discover",
    note: DISCOVER_NOTE,
    property: DISCOVER_PROPERTY,
    maxAgeDays: DISCOVER_MAX_AGE_DAYS,
  },
  {
    job: "daily-activity",
    command: "llmos-daily-activity",
    note: DIGEST_NOTE,
    property: DIGEST_PROPERTY,
    maxAgeDays: DIGEST_MAX_AGE_DAYS,
  },
];

export interface OverdueJob {
  job: string;
  /** The recorded value (a date, or the raw text when it is not a valid past date); null when none. */
  last_success: string | null;
  max_age_days: number;
}

export interface SchemaViolation {
  path: string;
  message: string;
}

export interface VaultHealth {
  orphans: string[];
  dead_ends: string[];
  unresolved_links: UnresolvedLink[];
  schema_violations: SchemaViolation[];
  stale_inbox: string[];
  overdue_jobs: OverdueJob[];
}

export interface QmdSection {
  qmd_gaps: string[];
  /**
   * Documents in the whole qmd index (every collection) that still need
   * embedding; `null` when qmd is unavailable. Informational: the Stop hook
   * updates only the keyword index, so this grows until `llmos-vault
   * reindex` runs. It does not make the report unclean.
   */
  qmd_unembedded: number | null;
  qmd_notice: string | null;
}

export interface HealthOptions {
  profile?: Profile;
  staleAfterDays?: number;
  /** Today, the day inbox ages count to. An unreadable `created` (not `YYYY-MM-DD`) is stale. */
  today: Day;
}

function schemaViolations(model: VaultModel, profile: Profile): SchemaViolation[] {
  if (profile !== "llmos") return [];
  return collectErrors(model).errors.map((error) => {
    const at = error.indexOf(": ");
    return at === -1
      ? { path: error, message: "" }
      : { path: error.slice(0, at), message: error.slice(at + 2) };
  });
}

function staleInbox(
  model: VaultModel,
  staleAfterDays: number,
  day: Day,
  profile: Profile,
): string[] {
  const stale: string[] = [];
  for (const note of model.notes) {
    const inbox = profile === "llmos" ? isInboxDrop(note.path) : note.path.startsWith("inbox/");
    if (!inbox) continue;
    const created = note.properties.created;
    const createdDay = typeof created === "string" ? parseDay(created) : null;
    if (createdDay === null || day - createdDay >= staleAfterDays) stale.push(note.path);
  }
  return stale.sort();
}

/**
 * The jobs that are overdue for the llmOS profile: a job is overdue when its
 * record is missing, not a valid `YYYY-MM-DD` date, in the future (the
 * record fails closed, beyond `RUN_RECORD_CLOCK_SKEW_DAYS`), or more than its
 * `maxAgeDays` old.
 */
function overdueJobs(model: VaultModel, profile: Profile, today: Day): OverdueJob[] {
  if (profile !== "llmos") return [];
  return RUN_RECORDS.flatMap((record) => {
    const value = model.notes.find((note) => note.path === record.note)?.properties[
      record.property
    ];
    const text = typeof value === "string" ? value : null;
    const day = text === null ? null : parseDay(text);
    if (
      day !== null &&
      day - today <= RUN_RECORD_CLOCK_SKEW_DAYS &&
      today - day <= record.maxAgeDays
    )
      return [];
    return [{ job: record.job, last_success: text, max_age_days: record.maxAgeDays }];
  });
}

/** Aggregate vault hygiene into one report. */
export function vaultHealth(model: VaultModel, options: HealthOptions): VaultHealth {
  const llmos = (options.profile ?? "llmos") === "llmos";
  const hubs = categoryHubs(model);
  return {
    ...model.linkFindings(
      (note) => llmos && hasValidCategory(note, hubs),
      (note) => llmos && isTemplate(note),
      (note) => llmos && isMemoryNote(note.path),
    ),
    schema_violations: schemaViolations(model, options.profile ?? "llmos"),
    stale_inbox: staleInbox(
      model,
      options.staleAfterDays ?? 14,
      options.today,
      options.profile ?? "llmos",
    ),
    overdue_jobs: overdueJobs(model, options.profile ?? "llmos", options.today),
  };
}

/**
 * Notes the qmd collection does not hold, given the collection's paths
 * (`null` when qmd or the collection is unavailable, which gives a notice
 * instead of failing the report).
 */
export function qmdSection(
  model: VaultModel,
  indexed: ReadonlySet<string> | null,
  collection: string,
  unembedded: number | null = null,
): QmdSection {
  if (indexed === null) {
    return {
      qmd_gaps: [],
      qmd_unembedded: unembedded,
      qmd_notice: `qmd unavailable or collection '${collection}' not found; qmd-gap section skipped`,
    };
  }
  const paths = [...model.notes, ...model.brokenLinks].map((entry) => entry.path);
  return {
    qmd_gaps: paths.filter((path) => !indexed.has(path)).sort(),
    qmd_unembedded: unembedded,
    qmd_notice: null,
  };
}

/** A report with no findings in any section (a qmd notice is not a finding). */
export function isClean(report: VaultHealth & QmdSection): boolean {
  return (
    report.orphans.length === 0 &&
    report.dead_ends.length === 0 &&
    report.unresolved_links.length === 0 &&
    report.schema_violations.length === 0 &&
    report.stale_inbox.length === 0 &&
    report.overdue_jobs.length === 0 &&
    report.qmd_gaps.length === 0
  );
}

/** The readable report: one line per section with its count. */
export function summary(report: VaultHealth & QmdSection): string {
  const list = (items: string[]): string => items.join(", ") || "none";
  const lines = [
    `orphans (${report.orphans.length}): ${list(report.orphans)}`,
    `dead-ends (${report.dead_ends.length}): ${list(report.dead_ends)}`,
    `unresolved links (${report.unresolved_links.length}): ${list(
      report.unresolved_links.map((link) => `${link.referrer} -> ${link.target}`),
    )}`,
    `schema violations (${report.schema_violations.length}): ${list(
      report.schema_violations.map((violation) => `${violation.path}: ${violation.message}`),
    )}`,
    `stale inbox (${report.stale_inbox.length}): ${list(report.stale_inbox)}`,
    `overdue jobs (${report.overdue_jobs.length}): ${list(
      report.overdue_jobs.map(
        (job) =>
          `${job.job} (last success: ${job.last_success ?? "missing or unreadable"}; max ${job.max_age_days} days)`,
      ),
    )}`,
    `qmd gaps (${report.qmd_gaps.length}): ${list(report.qmd_gaps)}`,
  ];
  if (report.qmd_unembedded) {
    lines.push(
      `qmd unembedded: ${report.qmd_unembedded} documents need embedding (run llmos-vault reindex)`,
    );
  }
  if (report.qmd_notice) lines.push(`qmd notice: ${report.qmd_notice}`);
  return lines.join("\n");
}
