/**
 * TypeScript side of the differential harness: the same results, in the same
 * shapes, as `python_oracle.py` gets from the Python CLI. CLI results come
 * from `runCli` with the harness's vault model, so they are what
 * `llmos-vault` prints and its exit code. qmd reads as unavailable (no
 * index), as on the Python side.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, runCli } from "../../src/cli.ts";
import { COMMANDS } from "../../src/commands.ts";
import { normalize } from "../../src/frontmatter.ts";
import { collectErrors } from "../../src/schema.ts";
import { AmbiguousNoteError, NoteNotFoundError, type VaultModel } from "../../src/vault.ts";

export interface OracleResults {
  list: unknown[];
  daily_recent: unknown;
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

function guard(call: () => unknown): unknown {
  try {
    return call();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: errorKind(error), message: error.message };
  }
}

export async function typescriptResults(
  model: VaultModel,
  today: string,
  depth2: (path: string) => boolean,
): Promise<OracleResults> {
  const home = mkdtempSync(join(tmpdir(), "llmos-differential-home-"));
  const context: Context = {
    env: { HOME: home, INDEX_PATH: join(home, "no-index.sqlite"), QMD_CONFIG_DIR: home },
    root: () => model.root,
    model: () => model,
    today: () => today,
    obsidian: () => {
      throw new Error("the harness runs read verbs only");
    },
  };
  const cli = async (
    ...argv: string[]
  ): Promise<{ exit: number; json?: unknown; error?: string }> => {
    const result = await runCli(argv, COMMANDS, context);
    if (result.stdout === "") return { exit: result.exitCode, error: result.stderr.trimEnd() };
    return { exit: result.exitCode, json: JSON.parse(result.stdout) };
  };

  const notes: Record<string, Record<string, unknown>> = {};
  for (const note of model.notes) {
    const result: Record<string, unknown> = {
      read: await cli("read", note.path),
      neighbors: await cli("neighbors", note.path),
      subgraph1: await cli("subgraph", note.path, "--depth", "1"),
      check: await cli("check", note.path),
      normalize: guard(() => normalize(note.text)),
    };
    if (depth2(note.path)) result.subgraph2 = await cli("subgraph", note.path, "--depth", "2");
    notes[note.path] = result;
  }
  const byName: Record<string, unknown> = {};
  for (const name of new Set(model.notes.map((note) => note.name))) {
    byName[name] = await cli("read", name);
  }
  const health = await cli("health", "--json");
  return {
    list: (await cli("list")).json as unknown[],
    daily_recent: await cli("daily", "recent", "--n", "2"),
    notes,
    by_name: byName,
    health: { ...(health.json as object), exit: health.exit },
    schema: collectErrors(model),
  };
}
