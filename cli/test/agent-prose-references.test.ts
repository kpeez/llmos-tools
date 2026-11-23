/** Agent-facing prose must not name a repo path or an `llmos` command that does not exist. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { COMMANDS } from "../src/commands.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLI_DIR = join(ROOT, "cli");

/** Paths that a checkout does not hold, with the reason. */
const ABSENT_BY_DESIGN = new Map([
  [".agents/docs", "a link to the vault, which Git ignores (AGENTS.md)"],
  [".agents/scratch", "a per-branch scratch link that Git ignores"],
  ["artifacts", "run output that Git ignores"],
  [".claude/settings.local.json", "a file in each vault project, not in this repo"],
  ["node_modules", "installed by `bun install`, not committed"],
]);

/** Folders that held repo files before the vault split. A prose path under one is stale. */
const RETIRED_ROOTS = new Set(["tools"]);

const NOT_A_PATH = new Map([["tools/list", "an MCP method name"]]);

const PLACEHOLDER = /[<>*$~{}|\s]|^https?:|^\/|\.\.\.|^[a-z]+:\/\//;

const groups = new Set(
  COMMANDS.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]),
);
const names = new Set(COMMANDS.map((c) => c.name));
const rootEntries = new Set([...readdirSync(ROOT), ...readdirSync(CLI_DIR)]);

/** The folder, then each parent up to the repo root: a reader resolves `scripts/x.ts` against the skill folder. */
function ancestors(dir: string): string[] {
  const out = [dir];
  while (out.at(-1) !== ROOT && out.at(-1) !== dirname(out.at(-1) ?? ROOT)) {
    out.push(dirname(out.at(-1) ?? ROOT));
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function unreleasedOnly(text: string): string {
  const start = text.indexOf("## Unreleased");
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

/** The text of every string literal in a TypeScript source, with no comments. */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
    } else if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let text = "";
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") {
          i++;
          text += source[i] === "n" ? "\n" : source[i];
        } else text += source[i];
        i++;
      }
      out.push(text);
    }
    i++;
  }
  return out;
}

interface Source {
  label: string;
  dir: string;
  text: string;
}

function sources(): Source[] {
  const files: Source[] = [];
  const markdown = [
    join(ROOT, "AGENTS.md"),
    join(ROOT, "README.md"),
    ...walk(join(ROOT, "docs")),
    ...walk(join(ROOT, "skills")),
    ...walk(join(ROOT, ".agents/skills")),
  ].filter((file) => file.endsWith(".md"));
  for (const file of markdown) {
    files.push({
      label: file.slice(ROOT.length + 1),
      dir: dirname(file),
      text: readFileSync(file, "utf8"),
    });
  }
  const changelog = join(ROOT, "CHANGELOG.md");
  files.push({
    label: "CHANGELOG.md (Unreleased)",
    dir: ROOT,
    text: unreleasedOnly(readFileSync(changelog, "utf8")),
  });
  for (const manifest of [".claude-plugin", ".codex-plugin", ".antigravity-plugin"]) {
    const file = join(ROOT, manifest, "plugin.json");
    files.push({ label: `${manifest}/plugin.json`, dir: ROOT, text: readFileSync(file, "utf8") });
  }
  const hooksDir = join(CLI_DIR, "src/hooks");
  for (const entry of readdirSync(hooksDir)) {
    const file = join(hooksDir, entry);
    files.push({
      label: `cli/src/hooks/${entry} (strings)`,
      dir: ROOT,
      text: stringLiterals(readFileSync(file, "utf8")).join("\n"),
    });
  }
  return files;
}

interface Reference {
  label: string;
  line: number;
  kind: "path" | "command";
  value: string;
  problem: string;
}

function checkPath(source: Source, span: string): string | undefined {
  const path = span.replace(/:\d+(-\d+)?$/, "").replace(/\/+$/, "");
  if (PLACEHOLDER.test(path) || !path.includes("/") || NOT_A_PATH.has(path)) return undefined;
  const first = path.split("/")[0] ?? "";
  if (first !== ".." && first !== "." && !rootEntries.has(first) && !RETIRED_ROOTS.has(first)) {
    return undefined;
  }
  if (
    ABSENT_BY_DESIGN.has(path) ||
    [...ABSENT_BY_DESIGN.keys()].some((p) => path.startsWith(`${p}/`))
  ) {
    return undefined;
  }
  const bases = [...ancestors(source.dir), CLI_DIR];
  return bases.some((base) => existsSync(resolve(base, path))) ? undefined : "no such path";
}

const SPAN_COMMAND = /^llmos ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/;
const LINE_COMMAND = /(?:^\s*(?:\$\s+)?|[|;&(]\s*)llmos ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/;

function commandOf(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  const [, first = "", second] = match;
  if (groups.has(first) && !second) return undefined;
  const candidate = groups.has(first) ? `${first} ${second}` : first;
  return names.has(candidate) || candidate === "help" ? undefined : candidate;
}

function references(source: Source): Reference[] {
  const found: Reference[] = [];
  const lines = source.text.split("\n");
  let fenced = false;
  lines.forEach((line, index) => {
    const at = { label: source.label, line: index + 1 };
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      const bad = commandOf(line, LINE_COMMAND);
      if (bad)
        found.push({ ...at, kind: "command", value: bad, problem: "not in the command registry" });
      return;
    }
    for (const [, span = ""] of line.matchAll(/`([^`]+)`/g)) {
      const bad = commandOf(span, SPAN_COMMAND);
      if (bad)
        found.push({ ...at, kind: "command", value: bad, problem: "not in the command registry" });
      const problem = checkPath(source, span);
      if (problem) found.push({ ...at, kind: "path", value: span, problem });
    }
  });
  return found;
}

describe("agent-facing prose", () => {
  test("every backticked repo path exists and every `llmos` command is registered", () => {
    const stale = sources().flatMap(references);
    expect(
      stale.map((r) => `${r.label}:${r.line}: ${r.kind} \`${r.value}\`: ${r.problem}`),
    ).toEqual([]);
  });
});
