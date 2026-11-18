/**
 * Record the contract snapshots again from the TypeScript output (see
 * `snapshot.ts`). Run it only for an intended contract change, from
 * `cli/`: `just contract-record`, then review the diff.
 *
 * It keeps each `differs_from_python` annotation, and its reason in
 * `allowlist`, while the annotated result is unchanged; it drops (and
 * prints) an annotation whose result changed or no longer exists, because
 * Python never gave the new result. It refuses to record when a digest
 * day's second run is not a no-op, and writes nothing until every snapshot
 * is computed.
 */

import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { EDGE_DAYS } from "./digest_edge.ts";
import { runEdgeDays } from "./digest_run.ts";
import {
  CLI_ABOUT,
  type CliSnapshot,
  cliSnapshotPath,
  DIGEST_ABOUT,
  DIGEST_SNAPSHOT_PATH,
  type DigestDay,
  type DigestSnapshot,
  NO_OP,
  readSnapshot,
  SNAPSHOT_DAY,
  SNAPSHOT_VAULTS,
  writeSnapshot,
} from "./snapshot.ts";
import { flatResults, withVault } from "./vaults.ts";

/** The reasons of the allowlist entries still named, from `previous`. */
function usedAllowlist(previous: Record<string, string>, named: string[]): Record<string, string> {
  const used = new Set(named);
  return Object.fromEntries(Object.entries(previous).filter(([id]) => used.has(id)));
}

const writes: [string, CliSnapshot | DigestSnapshot][] = [];

for (const vault of SNAPSHOT_VAULTS) {
  const path = cliSnapshotPath(vault);
  const previous = existsSync(path) ? readSnapshot<CliSnapshot>(path) : undefined;
  const results = await withVault(vault, (model) => flatResults(model, SNAPSHOT_DAY));
  const differs: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(previous?.differs_from_python ?? {})) {
    if (name in results && isDeepStrictEqual(results[name], previous?.results[name])) {
      differs[name] = ids;
    } else {
      console.log(`${vault}: dropped the annotation of ${name}, whose result changed`);
    }
  }
  writes.push([
    path,
    {
      about: CLI_ABOUT,
      today: SNAPSHOT_DAY,
      allowlist: usedAllowlist(previous?.allowlist ?? {}, Object.values(differs).flat()),
      differs_from_python: differs,
      results,
    },
  ]);
}

const previous = existsSync(DIGEST_SNAPSHOT_PATH)
  ? readSnapshot<DigestSnapshot>(DIGEST_SNAPSHOT_PATH)
  : undefined;
const days = runEdgeDays(EDGE_DAYS.map(([day]) => day)).map(
  ({ againChangedFiles, ...day }): DigestDay => {
    if (againChangedFiles) throw new Error(`${day.day}: a second run changed the vault`);
    if (day.exit === 0 && !NO_OP.test(day.again)) {
      throw new Error(`${day.day}: a second run was not a no-op: ${day.again.trim()}`);
    }
    const before = previous?.days.find((entry) => entry.day === day.day);
    let differs = before?.differs_from_python ?? [];
    if (before !== undefined && differs.length > 0) {
      const { differs_from_python: _, ...recorded } = before;
      if (!isDeepStrictEqual(day, recorded)) {
        console.log(`digest: dropped the annotations of ${day.day}, whose result changed`);
        differs = [];
      }
    }
    return { ...day, differs_from_python: differs };
  },
);
writes.push([
  DIGEST_SNAPSHOT_PATH,
  {
    about: DIGEST_ABOUT,
    allowlist: usedAllowlist(
      previous?.allowlist ?? {},
      days.flatMap((day) => day.differs_from_python),
    ),
    days,
  },
]);

for (const [path, snapshot] of writes) {
  writeSnapshot(path, snapshot);
  console.log(`wrote ${path}`);
}
