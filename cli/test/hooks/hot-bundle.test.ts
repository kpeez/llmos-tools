/**
 * `pre-tool-use` and `guard-bash` run on almost every tool call, and Bun
 * loads a whole bundle before it runs one line. The hot entry point must not
 * pull in the YAML, memory, or vault-model code that only `session-start`,
 * `post-tool-use`, and `stop` need: each costs start-up time on every call.
 */

import { expect, test } from "bun:test";
import { entryOf } from "./helpers.ts";

const HEAVY = ["node_modules/yaml/", "/src/memory.ts", "/src/vault.ts", "/src/frontmatter.ts"];

test("the entry point of the hot events bundles no YAML, memory, or vault-model code", async () => {
  const build = await Bun.build({
    entrypoints: [entryOf("pre-tool-use")],
    target: "bun",
    metafile: true,
  });
  expect(build.success).toBe(true);
  const inputs = Object.keys(build.metafile?.inputs ?? {});
  expect(inputs.length).toBeGreaterThan(0);
  expect(inputs.filter((path) => HEAVY.some((heavy) => path.includes(heavy)))).toEqual([]);
});
