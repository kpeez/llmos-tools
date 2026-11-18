#!/usr/bin/env bun
/**
 * Generate the Claude and Codex marketplace catalogs at the llmos repository
 * root from the plugin manifest. The plugin lives in `tools/`; both
 * harnesses read their catalog from the root. Run from anywhere:
 *
 *   bun cli/scripts/gen-marketplaces.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PLUGIN_ROOT = resolve(import.meta.dir, "../..");
const REPO_ROOT = PLUGIN_ROOT;
const PLUGIN_SOURCE = "./";
const MARKETPLACE_NAME = "llmos-vault";

const manifest = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
) as { name: string };

const claude = {
  name: MARKETPLACE_NAME,
  description:
    "llmOS Obsidian vault plugin and deterministic maintenance tooling for AI coding agents",
  owner: { name: "kpeez", email: "25070796+kpeez@users.noreply.github.com" },
  plugins: [{ name: manifest.name, source: PLUGIN_SOURCE }],
};

const agents = {
  name: MARKETPLACE_NAME,
  interface: { displayName: MARKETPLACE_NAME },
  plugins: [
    {
      name: manifest.name,
      source: { source: "local", path: PLUGIN_SOURCE },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Productivity",
    },
  ],
};

for (const [path, catalog] of [
  [join(REPO_ROOT, ".claude-plugin", "marketplace.json"), claude],
  [join(REPO_ROOT, ".agents", "plugins", "marketplace.json"), agents],
] as const) {
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`wrote ${relative(REPO_ROOT, path)}`);
}
