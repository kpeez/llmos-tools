/**
 * TypeScript side of the differential harness: the same results, in the same
 * JSON shapes, as `python_oracle.py` gets from the Python CLI.
 */

import { checkNote } from "../../src/authoring.ts";
import { type DayNumber, sortedStrings } from "../../src/compat.ts";
import { normalize } from "../../src/frontmatter.ts";
import { vaultHealth } from "../../src/health.ts";
import { collectErrors } from "../../src/schema.ts";
import { AmbiguousNoteError, NoteNotFoundError, type VaultModel } from "../../src/vault.ts";

export interface OracleResults {
  list: unknown[];
  notes: Record<string, Record<string, unknown>>;
  by_name: Record<string, unknown>;
  health: unknown;
  schema: { errors: string[]; checked: number };
}

function errorKind(error: Error): string {
  if (error instanceof NoteNotFoundError) return "not-found";
  if (error instanceof AmbiguousNoteError) return "ambiguous";
  return error.name;
}

/** The value as the CLI would print it: through JSON. */
function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function guard(call: () => unknown): unknown {
  try {
    return json(call());
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: errorKind(error), message: error.message };
  }
}

export function typescriptResults(
  model: VaultModel,
  today: DayNumber,
  depth2: (path: string) => boolean,
): OracleResults {
  const notes: Record<string, Record<string, unknown>> = {};
  for (const note of model.notes) {
    const result: Record<string, unknown> = {
      read: guard(() => model.read(note.path)),
      neighbors: guard(() => model.neighbors(note.path)),
      subgraph1: guard(() => model.subgraph(note.path, 1)),
      check: guard(() => checkNote(model, note)),
      normalize: guard(() => normalize(note.text)),
    };
    if (depth2(note.path)) result.subgraph2 = guard(() => model.subgraph(note.path, 2));
    notes[note.path] = result;
  }
  const byName: Record<string, unknown> = {};
  for (const name of sortedStrings(new Set(model.notes.map((note) => note.name)))) {
    byName[name] = guard(() => model.read(name));
  }
  return {
    list: json(model.list()) as unknown[],
    notes,
    by_name: byName,
    health: json(vaultHealth(model, { profile: "llmos", today })),
    schema: collectErrors(model),
  };
}
