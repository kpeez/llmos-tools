/**
 * The CLI's external contract on the fixture vaults and the generated edge
 * vault: every result must equal its committed snapshot (see `snapshot.ts`),
 * and the frontmatter invariants must hold on every note.
 */

import { describe, expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { checkInvariants } from "./invariants.ts";
import { type CliSnapshot, cliSnapshotPath, readSnapshot, SNAPSHOT_VAULTS } from "./snapshot.ts";
import { flatResults, withVault } from "./vaults.ts";

describe.each([...SNAPSHOT_VAULTS])("%s", (vault) => {
  const snapshot = readSnapshot<CliSnapshot>(cliSnapshotPath(vault));

  test("every contract result matches the snapshot", async () => {
    const results = await withVault(vault, (model) => flatResults(model, snapshot.today));
    const names = [...new Set([...Object.keys(snapshot.results), ...Object.keys(results)])];
    const mismatches = names
      .filter((name) => !isDeepStrictEqual(results[name], snapshot.results[name]))
      .map((name) => ({ name, snapshot: snapshot.results[name], typescript: results[name] }));
    // Record again with `just contract-record` only for an intended contract change.
    expect(mismatches).toEqual([]);
  });

  test("every annotation names a result and an allowlist entry it explains", () => {
    for (const [name, ids] of Object.entries(snapshot.differs_from_python)) {
      expect(snapshot.results).toHaveProperty([name]);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(snapshot.allowlist).toHaveProperty([id]);
    }
    const used = new Set(Object.values(snapshot.differs_from_python).flat());
    expect(Object.keys(snapshot.allowlist).filter((id) => !used.has(id))).toEqual([]);
  });

  test("normalize keeps values, is idempotent, and refuses only invalid YAML", async () => {
    const report = await withVault(vault, checkInvariants);
    expect(report.violations).toEqual([]);
  });
});
