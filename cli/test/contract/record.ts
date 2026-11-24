/**
 * Record the contract snapshots again from the CLI and digest output (see
 * `snapshot.ts`). Run it only for an intended contract change, from
 * `cli/`: `just contract-record`, then review the diff.
 *
 * It refuses to record when a digest day's second run is not a no-op, and
 * writes nothing until every snapshot is computed.
 */

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
  SNAPSHOT_DAY,
  SNAPSHOT_VAULTS,
  writeSnapshot,
} from "./snapshot.ts";
import { flatResults, withVault } from "./vaults.ts";

const writes: [string, CliSnapshot | DigestSnapshot][] = [];

for (const vault of SNAPSHOT_VAULTS) {
  const results = await withVault(vault, (model) => flatResults(model, SNAPSHOT_DAY));
  writes.push([cliSnapshotPath(vault), { about: CLI_ABOUT, today: SNAPSHOT_DAY, results }]);
}

const days = runEdgeDays(EDGE_DAYS.map(([day]) => day)).map(
  ({ againChangedFiles, ...day }): DigestDay => {
    if (againChangedFiles) throw new Error(`${day.day}: a second run changed the vault`);
    if (day.exit === 0 && !NO_OP.test(day.again)) {
      throw new Error(`${day.day}: a second run was not a no-op: ${day.again.trim()}`);
    }
    return day;
  },
);
writes.push([DIGEST_SNAPSHOT_PATH, { about: DIGEST_ABOUT, days }]);

for (const [path, snapshot] of writes) {
  writeSnapshot(path, snapshot);
  console.log(`wrote ${path}`);
}
