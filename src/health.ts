/**
 * The vault health report: orphans, dead-ends, unresolved wikilinks, schema
 * violations, and stale inbox items, computed from one vault model.
 *
 * Schema violations are the llmOS profile's contract and are skipped for a
 * plain vault such as second-vault ("core" profile). The qmd index gaps compare the
 * vault's notes with the paths a qmd collection holds; the caller reads those
 * paths from the qmd store (`qmd.ts`), so this module stays synchronous and
 * never imports qmd.
 */

import { type DayNumber, parseIsoDate, pathParts, sortedStrings, today } from "./compat.ts";
import { collectErrors } from "./schema.ts";
import type { UnresolvedLink, VaultModel } from "./vault.ts";

export type Profile = "llmos" | "core";

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
  today?: DayNumber;
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

function staleInbox(model: VaultModel, staleAfterDays: number, day: DayNumber): string[] {
  const stale: string[] = [];
  for (const note of model.notes) {
    if (pathParts(note.path)[0] !== "inbox") continue;
    const created = note.properties.created;
    const createdDay = typeof created === "string" ? parseIsoDate(created) : null;
    if (createdDay === null || day - createdDay >= staleAfterDays) stale.push(note.path);
  }
  return sortedStrings(stale);
}

/** Aggregate vault hygiene into one report. */
export function vaultHealth(model: VaultModel, options: HealthOptions = {}): VaultHealth {
  return {
    ...model.linkFindings(),
    schema_violations: schemaViolations(model, options.profile ?? "llmos"),
    stale_inbox: staleInbox(model, options.staleAfterDays ?? 14, options.today ?? today()),
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
