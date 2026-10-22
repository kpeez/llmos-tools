import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPAIR_MESSAGE, resolveVaultRoot, VaultRootError, vaultRoot } from "../src/root.ts";

const scratch = mkdtempSync(join(tmpdir(), "llmos-root-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function vault(name: string): string {
  const root = join(scratch, name);
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Vault\n");
  return root;
}

function file(name: string, value: unknown): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const fromEnv = vault("env-vault");
const fromConfig = vault("config-vault");
const second-vault = vault("second-vault");
const config = file("config.json", { vault_root: fromConfig });
const missing = join(scratch, "missing.json");

describe("vaultRoot", () => {
  test("$LLMOS_ROOT wins over the config file", () => {
    expect(vaultRoot({ env: { LLMOS_ROOT: fromEnv }, configPath: config })).toBe(fromEnv);
    expect(vaultRoot({ env: {}, configPath: config })).toBe(fromConfig);
  });

  test("an invalid or unconfigured root throws VaultRootError instead of exiting", () => {
    const noAgents = join(scratch, "no-agents");
    mkdirSync(join(noAgents, ".obsidian"), { recursive: true });
    const noObsidian = join(scratch, "no-obsidian");
    mkdirSync(noObsidian, { recursive: true });
    writeFileSync(join(noObsidian, "AGENTS.md"), "# Not a vault\n");
    for (const notAVault of [noAgents, noObsidian]) {
      expect(() => vaultRoot({ env: { LLMOS_ROOT: notAVault }, configPath: config })).toThrow(
        VaultRootError,
      );
    }
    expect(() => vaultRoot({ env: {}, configPath: missing })).toThrow(REPAIR_MESSAGE);
  });
});

describe("resolveVaultRoot", () => {
  const registry = file("obsidian.json", {
    vaults: { a: { path: fromConfig, ts: 1 }, b: { path: second-vault, ts: 2 } },
  });

  test("a vault name other than llmos is found in Obsidian's registry by folder name", () => {
    expect(
      resolveVaultRoot("second-vault", { env: {}, configPath: config, registryPath: registry }),
    ).toBe(second-vault);
    expect(resolveVaultRoot("llmos", { env: {}, configPath: config, registryPath: missing })).toBe(
      fromConfig,
    );
  });

  test("an unknown name or a missing registry throws VaultRootError", () => {
    expect(() => resolveVaultRoot("nope", { registryPath: registry })).toThrow(VaultRootError);
    expect(() => resolveVaultRoot("second-vault", { registryPath: missing })).toThrow(VaultRootError);
  });
});
