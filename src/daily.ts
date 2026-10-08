/**
 * llmOS-profile daily-note helpers: reading recent notes and computing the
 * body for a new thought. `write.ts` writes the note.
 *
 * The `## Projects` section between the `llmos-activity` markers is
 * machine-owned: the activity digest writes it, and nothing else may write
 * inside it. The marker strings are defined here once and shared with the
 * digest. A plain vault such as second-vault has no daily-note contract.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { comparePaths, type DayNumber, isoDate, rstrip, strip, today } from "./compat.ts";
import type { Note, VaultModel } from "./vault.ts";

export const DAILY_DIR = "reviews/daily";
// The start marker is a prefix: the digest writes
// `<!-- llmos-activity:start hash=<sha256> -->`, the template a bare
// `<!-- llmos-activity:start -->`. Both match on this one string.
export const MARKER_START = "<!-- llmos-activity:start";
export const MARKER_END = "<!-- llmos-activity:end -->";
export const THOUGHTS_HEADING = "## Thoughts";

/** A write would land inside the machine-owned `llmos-activity` block. */
export class MachineOwnedBlock extends Error {
  override name = "MachineOwnedBlock";
}

function insertUnderHeading(text: string, heading: string, addition: string): string {
  const at = text.indexOf(heading);
  if (at === -1) throw new Error(`note has no '${heading}' heading`);
  const start = at + heading.length;
  const rest = text.slice(start);
  const next = rest.indexOf("\n## ");
  const [section, tail] = next === -1 ? [rest, ""] : [rest.slice(0, next), rest.slice(next)];
  return `${text.slice(0, start)}${rstrip(section, "\n")}\n\n${strip(addition)}\n${tail}`;
}

/** Throw `MachineOwnedBlock` when a thought contains `llmos-activity` marker syntax. */
export function refuseMarkerSyntax(thought: string): void {
  if (thought.includes(MARKER_START) || thought.includes(MARKER_END)) {
    throw new MachineOwnedBlock(
      "refusing to write llmos-activity marker syntax into ## Thoughts -- that block is machine-owned",
    );
  }
}

/**
 * A daily note body with `thought` appended as a paragraph under
 * `## Thoughts`. Everything from the `llmos-activity` start marker onward is
 * kept byte for byte. Throws `MachineOwnedBlock` when the thought contains
 * marker syntax or the body has no start marker, and an `Error` when the part
 * before the marker has no `## Thoughts` heading.
 */
export function bodyWithThought(body: string, thought: string): string {
  refuseMarkerSyntax(thought);
  const marker = body.indexOf(MARKER_START);
  if (marker === -1) {
    throw new MachineOwnedBlock("note has no llmos-activity markers -- refusing to append blind");
  }
  return insertUnderHeading(body.slice(0, marker), THOUGHTS_HEADING, thought) + body.slice(marker);
}

/** The vault-relative path of the daily note for `day` (today by default). */
export function dailyPath(day: DayNumber = today()): string {
  return `${DAILY_DIR}/${isoDate(day)}.md`;
}

/**
 * The last `n` daily notes, most recent first. ISO-dated file names sort
 * chronologically.
 */
export function readRecentDailies(model: VaultModel, n: number): Note[] {
  const folder = join(model.root, DAILY_DIR);
  if (!(existsSync(folder) && statSync(folder).isDirectory())) return [];
  const paths = readdirSync(folder)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `${DAILY_DIR}/${name}`)
    .sort((a, b) => comparePaths(b, a));
  return paths.slice(0, n).map((path) => model.resolveNote(path));
}
