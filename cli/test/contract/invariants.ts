/**
 * Invariants of the frontmatter reader and the canonical writer, checked on
 * every note of a vault. They need no reference implementation, so they run
 * on a copy of the real vault as well as on the test vaults:
 *
 * - `parse-error`: reading a note gives its properties or a typed refusal
 *   (no frontmatter block, or a block that is not valid YAML properties),
 *   never another error;
 * - `refused-valid-yaml`: `normalize` never refuses a block it parsed (the
 *   writer's own safety check, "refusing to rewrite ...");
 * - `normalize-idempotent`: normalizing the output again changes nothing;
 * - `normalize-keeps-values`: the output reads back as the same properties.
 *
 * `VaultModel.load` reads every note first, so a note that is not valid
 * UTF-8 fails the run.
 *
 * Usage, from `cli/` (never on the live vault: copy the vault to a
 * folder outside it first, and write the report to `../artifacts/`):
 *   bun test/contract/invariants.ts [--report FILE] VAULT ...
 * It prints the refused notes with their reasons, which are expected for
 * blocks that are not valid YAML, and exits 1 on any violation.
 */

import { writeFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  MissingFrontmatter,
  normalize,
  parse,
  UnsupportedFrontmatter,
} from "../../src/frontmatter.ts";
import { VaultModel } from "../../src/vault.ts";

export interface Violation {
  path: string;
  invariant:
    | "parse-error"
    | "refused-valid-yaml"
    | "normalize-idempotent"
    | "normalize-keeps-values";
  detail: string;
}

export interface InvariantReport {
  notes: number;
  /** Notes `normalize` refuses, by path, with the reason: expected, not violations. */
  refused: Record<string, string>;
  violations: Violation[];
}

const SAFETY_CHECK = "refusing to rewrite";

export function checkInvariants(model: VaultModel): InvariantReport {
  const refused: Record<string, string> = {};
  const violations: Violation[] = [];
  for (const note of model.notes) {
    const violation = (invariant: Violation["invariant"], detail: string) =>
      violations.push({ path: note.path, invariant, detail });
    let before: ReturnType<typeof parse>;
    try {
      before = parse(note.text);
    } catch (error) {
      if (error instanceof MissingFrontmatter || error instanceof UnsupportedFrontmatter) {
        refused[note.path] = error.message;
      } else {
        violation("parse-error", String(error));
      }
      continue;
    }
    let once: string;
    try {
      once = normalize(note.text);
    } catch (error) {
      if (error instanceof UnsupportedFrontmatter && !error.message.startsWith(SAFETY_CHECK)) {
        refused[note.path] = error.message;
      } else {
        violation("refused-valid-yaml", String(error));
      }
      continue;
    }
    let twice: string;
    try {
      twice = normalize(once);
    } catch (error) {
      violation("normalize-idempotent", `normalizing the output again failed: ${String(error)}`);
      continue;
    }
    if (twice !== once) {
      violation("normalize-idempotent", JSON.stringify({ once, twice }));
    }
    const after = parse(once).properties;
    if (!isDeepStrictEqual(after, before.properties)) {
      violation("normalize-keeps-values", JSON.stringify({ before: before.properties, after }));
    }
  }
  return { notes: model.notes.length, refused, violations };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: { report: { type: "string" } },
  });
  if (positionals.length === 0) throw new Error("usage: invariants.ts [--report FILE] VAULT ...");
  const reports: Record<string, InvariantReport> = {};
  let violations = 0;
  for (const root of positionals) {
    const report = checkInvariants(VaultModel.load(root));
    reports[root] = report;
    violations += report.violations.length;
    const refused = Object.entries(report.refused);
    console.log(
      `${root}: ${report.notes} notes, ${refused.length} refused, ` +
        `${report.violations.length} violations`,
    );
    for (const [path, reason] of refused) console.log(`  refused ${path}: ${reason}`);
    for (const violation of report.violations) {
      console.log(`  ${violation.invariant} ${violation.path}: ${violation.detail.slice(0, 400)}`);
    }
  }
  if (values.report) writeFileSync(values.report, `${JSON.stringify(reports, null, 2)}\n`);
  process.exitCode = violations === 0 ? 0 : 1;
}
