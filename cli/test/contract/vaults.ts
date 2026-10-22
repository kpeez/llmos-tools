/** The contract vaults, ready to read: the fixture vaults and a freshly generated edge vault. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "../../src/authoring.ts";
import { VaultModel } from "../../src/vault.ts";
import { writeEdgeVault } from "./edge_vault.ts";
import { contractResults, flatten, relativize } from "./results.ts";
import { FIXTURES, type SnapshotVault } from "./snapshot.ts";

/**
 * Run `use` with the vault's model, read from its real path (the edge vault
 * is generated into a temporary folder, removed afterwards).
 */
export async function withVault<T>(
  vault: SnapshotVault,
  use: (model: VaultModel) => Promise<T> | T,
): Promise<T> {
  if (vault !== "edge_vault") return await use(VaultModel.load(realpath(join(FIXTURES, vault))));
  const scratch = mkdtempSync(join(tmpdir(), "llmos-contract-"));
  try {
    const root = join(scratch, "edge-vault");
    writeEdgeVault(root);
    return await use(VaultModel.load(realpath(root)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The flat contract results of a vault model on `today`, with every depth-2 subgraph. */
export async function flatResults(
  model: VaultModel,
  today: string,
): Promise<Record<string, unknown>> {
  const results = await contractResults(model, today, () => true);
  return flatten(relativize(results, model.root) as typeof results);
}
