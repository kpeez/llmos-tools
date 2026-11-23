/**
 * The Hermes provider keeps its own containment code (`hermes/__init__.py`
 * `_git`), so the Biome git lint does not reach it. This scan keeps git spawns
 * there to the one read-only `_git` helper.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "./helpers.ts";

const HERMES = join(TOOLS, "hermes");
const WRITE_VERBS =
  "add am apply branch checkout cherry-pick clean clone commit config fetch init merge mv pull push rebase reset restore revert rm stash switch tag update-ref worktree".split(
    " ",
  );

function helperBody(source: string): string {
  const start = source.indexOf("def _git(");
  const end = source.indexOf("\ndef ", start + 1);
  return start < 0 ? "" : source.slice(start, end < 0 ? undefined : end);
}

test("git runs in hermes/ only through the read-only _git helper", () => {
  const problems: string[] = [];
  for (const name of readdirSync(HERMES).filter((n) => n.endsWith(".py"))) {
    const source = readFileSync(join(HERMES, name), "utf8");
    const body = name === "__init__.py" ? helperBody(source) : "";
    const outside = body ? source.replace(body, "") : source;
    if (/["']git["']/.test(outside)) problems.push(`${name}: a git argv outside _git`);
    for (const verb of WRITE_VERBS) {
      if (new RegExp(`["']${verb}["']`).test(source))
        problems.push(`${name}: write verb "${verb}"`);
    }
  }
  expect(problems).toEqual([]);
});
