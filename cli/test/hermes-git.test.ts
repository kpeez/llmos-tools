/**
 * The Hermes provider keeps its own containment code (`hermes/__init__.py`
 * `_git`), so the Biome git lint does not reach it. This scan keeps git spawns
 * there to the one `_git` helper, and the verbs that reach it to read-only ones.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "./helpers.ts";

const HERMES = join(TOOLS, "hermes");
const READ_ONLY_VERBS = ["rev-parse", "diff", "ls-files", "log"];

function helperBody(source: string): string {
  const start = source.indexOf("def _git(");
  const end = source.indexOf("\ndef ", start + 1);
  return start < 0 ? "" : source.slice(start, end < 0 ? undefined : end);
}

/** The first verb of each tuple in a `for args in (...)` loop that feeds `_git(*args)`. */
function loopVerbs(source: string): string[] {
  const block = /for args in \(([\s\S]*?)\n {4}\):/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/\(\s*"([^"]+)"/g)].map((m) => m[1] as string);
}

test("git runs in hermes/ only through _git, with read-only verbs", () => {
  const problems: string[] = [];
  for (const name of readdirSync(HERMES).filter((n) => n.endsWith(".py"))) {
    const source = readFileSync(join(HERMES, name), "utf8");
    const body = name === "__init__.py" ? helperBody(source) : "";
    const outside = body ? source.replace(body, "") : source;
    if (/["']git["']/.test(outside)) problems.push(`${name}: a git argv outside _git`);
    for (const call of outside.matchAll(/\b_git\(\s*[^,()]+(?:\([^()]*\))?,\s*(\*?\w+|"[^"]*")/g)) {
      const verb = call[1] as string;
      if (verb.startsWith('"')) {
        if (!READ_ONLY_VERBS.includes(verb.slice(1, -1)))
          problems.push(`${name}: _git verb ${verb}`);
      } else {
        const verbs = loopVerbs(outside);
        if (verbs.length === 0) problems.push(`${name}: _git(${verb}) with no verb list to check`);
        for (const v of verbs) {
          if (!READ_ONLY_VERBS.includes(v)) problems.push(`${name}: _git verb "${v}"`);
        }
      }
    }
  }
  expect(problems).toEqual([]);
});
