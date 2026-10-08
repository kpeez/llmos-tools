/**
 * The vault health report: orphans, dead-ends, unresolved wikilinks, schema
 * violations, and stale inbox items, computed from one vault model.
 *
 * Schema violations are the llmOS profile's contract and are skipped for a
 * plain vault such as second-vault ("core" profile). The qmd index-gap section
 * arrives with the qmd SDK integration, not here.
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
