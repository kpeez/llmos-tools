/**
 * Vault-root resolution.
 *
 * The llmOS root comes from `$LLMOS_ROOT`, then the config file
 * (`vault_root`), and otherwise fails loudly. No branch derives the root from
 * this file's location or the working directory. Obsidian's own
 * registry separately lists every vault it knows, for `--vault NAME` (a
 * vault other than llmOS, found by its folder name) and for the Bash guard.
 *
 * Every failure throws `VaultRootError`. Only a CLI entry point may turn it
 * into an exit code.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "llmos", "config.json");
export const DEFAULT_REGISTRY_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "obsidian",
  "obsidian.json",
);

export const REPAIR_MESSAGE =
  "llmOS vault root is not configured. Run /setup-llmos, or set it manually:\n" +
  "  export LLMOS_ROOT=/path/to/vault";

export class VaultRootError extends Error {
  override name = "VaultRootError";
}

export interface RootOptions {
  configPath?: string;
  registryPath?: string;
  env?: Record<string, string | undefined>;
}

function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Return `path` if it is a real vault (`.obsidian/` and `AGENTS.md`); throw otherwise. */
export function validated(path: string): string {
  if (
    !(existsSync(path) && isDirectory(join(path, ".obsidian")) && isFile(join(path, "AGENTS.md")))
  ) {
    throw new VaultRootError(
      `llmOS root '${path}' is not a valid vault ` +
        `(must exist and contain .obsidian/ and AGENTS.md).\n${REPAIR_MESSAGE}`,
    );
  }
  return path;
}

/**
 * The llmOS config file as an object: `vault_root`, and the host settings
 * such as `github_owners`. A missing file, or one that holds no object, is
 * empty.
 */
export function readConfig(configPath: string = DEFAULT_CONFIG_PATH): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  return config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

/** Resolve the llmOS vault root: `$LLMOS_ROOT`, then the config file, else throw. */
export function vaultRoot(options: RootOptions = {}): string {
  const env = options.env ?? process.env;
  const fromEnv = env.LLMOS_ROOT;
  if (fromEnv) return validated(expandUser(fromEnv));
  const root = readConfig(options.configPath ?? DEFAULT_CONFIG_PATH).vault_root;
  if (root !== undefined) return validated(expandUser(String(root)));
  throw new VaultRootError(REPAIR_MESSAGE);
}

/** Every vault root Obsidian's registry knows about. Throws if the registry is missing. */
export function registeredVaults(registryPath: string = DEFAULT_REGISTRY_PATH): string[] {
  if (!existsSync(registryPath)) {
    throw new VaultRootError(
      `Obsidian vault registry not found at '${registryPath}'.\n` +
        "Open Obsidian at least once so it records its known vaults.",
    );
  }
  const registry: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
  const vaults =
    registry !== null && typeof registry === "object" && !Array.isArray(registry)
      ? ((registry as Record<string, unknown>).vaults ?? {})
      : {};
  const paths: string[] = [];
  for (const entry of Object.values(vaults as Record<string, unknown>)) {
    if (entry !== null && typeof entry === "object" && "path" in entry) {
      paths.push(expandUser(String((entry as { path: unknown }).path)));
    }
  }
  return paths;
}

/** Resolve a `--vault` name: "llmos" via `vaultRoot`, any other name from the registry. */
export function resolveVaultRoot(vault: string, options: RootOptions = {}): string {
  if (vault === "llmos") return vaultRoot(options);
  for (const path of registeredVaults(options.registryPath)) {
    if (basename(path) === vault) return path;
  }
  throw new VaultRootError(
    `no registered vault named '${vault}'. Open it in Obsidian at least once.`,
  );
}
