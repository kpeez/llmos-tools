/**
 * Committed snapshots of the external contract: the CLI's JSON
 * output and exit codes, the canonical `normalize` output, and the schema
 * audit on the fixture vaults and the generated edge vault (`cli.test.ts`),
 * and the activity digest's outcomes, block hash, markers, and notes on the
 * digest edge days (`digest.test.ts`).
 *
 * After an intended contract change, record again with `just contract-record`
 * (`record.ts`) and review the diff: every changed result is a contract change.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SNAPSHOT_DIR = join(import.meta.dir, "snapshots");

/** The committed fixture vaults (`vault`, `health_vault`). */
export const FIXTURES = join(import.meta.dir, "../fixtures");

/** The day the CLI snapshots read as today (`health` inbox ages, `daily recent`). */
export const SNAPSHOT_DAY = "2026-10-07";

/** The vaults with a CLI snapshot: the fixture vaults and the generated edge vault. */
export const SNAPSHOT_VAULTS = ["vault", "health_vault", "edge_vault"] as const;
export type SnapshotVault = (typeof SNAPSHOT_VAULTS)[number];

export interface CliSnapshot {
  about: string;
  today: string;
  /** Result name (see `flatten` in `results.ts`) -> the TypeScript result. */
  results: Record<string, unknown>;
}

export interface DigestDay {
  day: string;
  /** The first run's exit code and stdout. */
  exit: number;
  stdout: string;
  /** The stdout of a second run on the same vault: a no-op after a successful first run. */
  again: string;
  /** The argument lists of the first run's `gh` calls, in order. */
  gh: string[][];
  /** The references each model prompt of the first run requires, in call order. */
  required: string[];
  /** The day's note after the first run: its block hash, marker lines, and text (null when absent). */
  hash: string | null;
  markers: string[];
  note: string | null;
  /** SHA-256 of every file in the vault after the first run. */
  files: Record<string, string>;
}

export interface DigestSnapshot {
  about: string;
  days: DigestDay[];
}

export const CLI_ABOUT =
  "Contract results of the CLI on this vault, read on `today`; see test/contract/snapshot.ts.";

export const DIGEST_ABOUT =
  "Outcomes, gh calls, required references, block hashes, markers, and notes of the " +
  "activity digest on the digest edge days, run in order on one vault copy; see " +
  "test/contract/snapshot.ts.";

export function cliSnapshotPath(vault: SnapshotVault): string {
  return join(SNAPSHOT_DIR, `cli-${vault}.json`);
}

export const DIGEST_SNAPSHOT_PATH = join(SNAPSHOT_DIR, "digest-edge.json");

/** The stdout of a second digest run after a successful first run: nothing to do. */
export const NO_OP = /^\S+: (unchanged|silent)/;

export function readSnapshot<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeSnapshot(path: string, snapshot: CliSnapshot | DigestSnapshot): void {
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}
