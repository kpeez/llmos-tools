#!/usr/bin/env bun
/**
 * Run the model check of every model skill: each `.agents/skills/verify-*`
 * folder that holds a `.tla` file runs its `scripts/check.ts`. Exits 1 when a
 * check fails, when a model has no check, or when no model is found.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/run.ts";

/** TLC model checks take minutes; twenty ends a hung one. */
const CHECK_TIMEOUT_MS = 20 * 60_000;

const SKILLS = join(import.meta.dir, "..", "..", ".agents", "skills");

const models = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("verify-"))
  .map((d) => d.name)
  .filter((name) => readdirSync(join(SKILLS, name)).some((f) => f.endsWith(".tla")))
  .sort();

if (models.length === 0) {
  console.error(`no model skill (verify-* with a .tla file) in ${SKILLS}`);
  process.exit(1);
}

const failed: string[] = [];
for (const name of models) {
  const check = join(SKILLS, name, "scripts", "check.ts");
  console.log(`\n== ${name}`);
  if (!existsSync(check)) {
    console.error(`${name} has a model but no scripts/check.ts`);
    failed.push(name);
    continue;
  }
  const r = run(["bun", check], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) failed.push(name);
}

console.log(`\n${models.length - failed.length} of ${models.length} model checks passed`);
for (const name of failed) console.log(`FAILED: ${name}`);
process.exit(failed.length === 0 ? 0 : 1);
