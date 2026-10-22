/**
 * The external contract results of the CLI on one vault: what `llmos-vault`
 * prints for `list` (without its exit code, as the Python oracle recorded
 * it), and what it prints and its exit code for `daily recent --n 2`; for every
 * note `read`, `neighbors`, `subgraph` at depth 1 (and depth 2 where
 * `depth2` says so), and `check`; `read` by every note name; and `health
 * --json`. `normalize` and the schema audit (what `llmos-audit` reports) have
 * no CLI JSON form, so they come from their functions; a refusal is
 * `{error, message}`. CLI results come from `runCli` with the given vault
 * model. qmd reads as unavailable (no index), so its fields are the notice;
 * `test/qmd.test.ts` covers a real index.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, runCli } from "../../src/cli.ts";
import { COMMANDS } from "../../src/commands.ts";
import { normalize } from "../../src/frontmatter.ts";
import { collectErrors } from "../../src/schema.ts";
import { AmbiguousNoteError, NoteNotFoundError, type VaultModel } from "../../src/vault.ts";
import { offline } from "../helpers.ts";

export interface ContractResults {
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

export async function contractResults(
  model: VaultModel,
  today: string,
  depth2: (path: string) => boolean,
): Promise<ContractResults> {
  const home = mkdtempSync(join(tmpdir(), "llmos-contract-home-"));
  const context: Context = {
    env: { HOME: home, INDEX_PATH: join(home, "no-index.sqlite"), QMD_CONFIG_DIR: home },
    root: () => model.root,
    model: () => model,
    today: () => today,
    obsidian: () => {
      throw new Error("the contract results run read verbs only");
    },
    fetch: offline,
  };
  const cli = async (
    ...argv: string[]
  ): Promise<{ exit: number; json?: unknown; error?: string }> => {
    const result = await runCli(argv, COMMANDS, context);
    if (result.stdout === "") return { exit: result.exitCode, error: result.stderr.trimEnd() };
    return { exit: result.exitCode, json: JSON.parse(result.stdout) };
  };

  try {
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * The results as one flat map from a result name to its value, the form the
 * snapshots keep: `list`, `daily_recent`, `<section> <note path>` for each
 * per-note result (`read`, `neighbors`, `subgraph1`, `subgraph2`, `check`,
 * `normalize`), `by_name <name>`, `health.<field>`, `schema.errors`, and
 * `schema.checked`.
 */
export function flatten(results: ContractResults): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    list: results.list,
    daily_recent: results.daily_recent,
  };
  for (const [path, sections] of Object.entries(results.notes)) {
    for (const [section, value] of Object.entries(sections)) flat[`${section} ${path}`] = value;
  }
  for (const [name, value] of Object.entries(results.by_name)) flat[`by_name ${name}`] = value;
  for (const [field, value] of Object.entries(results.health as Record<string, unknown>)) {
    flat[`health.${field}`] = value;
  }
  flat["schema.errors"] = results.schema.errors;
  flat["schema.checked"] = results.schema.checked;
  return flat;
}

/** Replace the vault root in every string with `<vault>`, so results do not depend on where the vault is. */
export function relativize(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.replaceAll(root, "<vault>");
  if (Array.isArray(value)) return value.map((item) => relativize(item, root));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, relativize(item, root)]),
    );
  }
  return value;
}
