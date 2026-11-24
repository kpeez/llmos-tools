/**
 * The tla2tools pin lives in the three model-check scripts and in the CI
 * workflow. One edit that misses a copy would make CI check a different jar
 * than the one a developer runs.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "./helpers.ts";

const SKILLS = join(TOOLS, ".agents", "skills");

function pinOf(text: string, pattern: RegExp, file: string): string {
  const match = pattern.exec(text);
  if (!match) throw new Error(`${file} holds no tla2tools pin`);
  return `${match[1]} ${match[2]}`;
}

test("every copy of the tla2tools pin names the same jar url and sha256", () => {
  const scripts: string[] = [];
  for (const skill of readdirSync(SKILLS).filter((n) => n.startsWith("verify-"))) {
    if (!readdirSync(join(SKILLS, skill)).some((f) => f.endsWith(".tla"))) continue;
    const check = join(SKILLS, skill, "scripts", "check.ts");
    if (!readFileSync(check, "utf8").includes("tla2tools[url=")) {
      throw new Error(`${check} holds no tla2tools pin`);
    }
    scripts.push(check);
  }
  expect(scripts).not.toEqual([]);

  const pins = new Map<string, string>();
  for (const file of scripts) {
    pins.set(
      file,
      pinOf(
        readFileSync(file, "utf8"),
        /tla2tools\[url=([^,\]]+),checksum=sha256:([0-9a-f]{64})\]/,
        file,
      ),
    );
  }
  const workflow = join(TOOLS, ".github", "workflows", "tools.yml");
  const yaml = readFileSync(workflow, "utf8");
  const url = /curl -fsSL -o "\$jar" (\S+tla2tools\.jar)/.exec(yaml)?.[1];
  const sha = /echo "([0-9a-f]{64}) {2}\$jar" \| sha256sum -c -/.exec(yaml)?.[1];
  if (!url || !sha) throw new Error(`${workflow} holds no tla2tools pin`);
  pins.set(workflow, `${url} ${sha}`);

  expect(new Set(pins.values()).size, [...pins].map(([f, p]) => `${f}: ${p}`).join("\n")).toBe(1);
});
