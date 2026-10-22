#!/usr/bin/env bun
// llmos-audit: check every llmOS note against the property contract (read-only).
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultContext } from "../src/cli.ts";
import { collectErrors } from "../src/schema.ts";
import { VaultModel } from "../src/vault.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { root: { type: "string" }, help: { type: "boolean", short: "h" } },
});
if (values.help) {
  console.log(
    "Usage: llmos-audit [--root PATH]\n\n" +
      "Audit llmOS frontmatter contracts. Read-only. Prints each violation and exits 1,\n" +
      "or prints how many notes passed. --root defaults to the configured llmOS root.",
  );
  process.exit(0);
}
try {
  const root = values.root ? realpathSync(resolve(values.root)) : defaultContext().root("llmos");
  const { errors, checked } = collectErrors(VaultModel.load(root));
  if (errors.length > 0) {
    await Bun.write(Bun.stdout, `${errors.join("\n")}\n`);
    process.exit(1);
  }
  console.log(`metadata audit passed: ${checked} notes`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
