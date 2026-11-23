#!/usr/bin/env bun
/**
 * The only writer of the plugin version, and the check that guards it.
 *
 *   bun scripts/release.ts bump <major|minor|patch>   (just release <level>)
 *   bun scripts/release.ts check [--base <ref>]        (just release-check)
 *
 * `bump` sets the four version fields and moves the CHANGELOG `## Unreleased`
 * body under a dated release heading. `check` fails when the fields differ,
 * when the version differs from the base branch and the CHANGELOG has no
 * heading for it, or (with PR_TITLE set, as in CI) when the version changed
 * in a pull request whose title is not `chore(release): ...`. It only warns
 * when shipped paths changed since the last release and the version did not.
 * Neither command reads `--root` from anything but the argument list; tests
 * and demos pass a copy of the repository.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as git from "../src/git.ts";

export const VERSION_FILES = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".antigravity-plugin/plugin.json",
  "cli/package.json",
];
const SHIPPED = ["dist", "hooks", "skills", "cli/src"];
const LEVELS = ["major", "minor", "patch"] as const;
type Level = (typeof LEVELS)[number];
const VERSION_LINE = /^(\s*"version":\s*")([^"]+)(")/m;

export function bumpVersion(version: string, level: Level): string {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`not a MAJOR.MINOR.PATCH version: ${version}`);
  }
  const [major = 0, minor = 0, patch = 0] = parts;
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Put the `## Unreleased` body under a release heading; throws when the body is empty. */
export function moveUnreleased(changelog: string, version: string, date: string): string {
  const unreleased = changelog.match(/^## Unreleased\n([\s\S]*?)(?=^## )/m);
  if (!unreleased || (unreleased[1] ?? "").trim() === "") {
    throw new Error(
      "CHANGELOG.md has no entry under `## Unreleased`; write the release notes first",
    );
  }
  return changelog.replace("## Unreleased\n", `## Unreleased\n\n## ${version} — ${date}\n`);
}

export function hasHeading(changelog: string, version: string): boolean {
  const escaped = version.replaceAll(".", "\\.");
  return new RegExp(`^## ${escaped} — \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog);
}

export interface Facts {
  fields: Record<string, string>;
  baseVersion: string | null;
  changelog: string;
  prTitle: string | null;
}

export function failures(facts: Facts): string[] {
  const found: string[] = [];
  const versions = new Set(Object.values(facts.fields));
  if (versions.size > 1) {
    const listing = Object.entries(facts.fields)
      .map(([file, version]) => `${file} ${version}`)
      .join(", ");
    found.push(
      `the four version fields differ (${listing}); only \`just release <level>\` writes them`,
    );
  }
  const version = facts.fields[VERSION_FILES[0] as string] as string;
  if (facts.baseVersion !== null && version !== facts.baseVersion) {
    if (!hasHeading(facts.changelog, version)) {
      found.push(
        `the version moved from ${facts.baseVersion} to ${version}, but CHANGELOG.md has no \`## ${version} — YYYY-MM-DD\` heading; use \`just release <level>\``,
      );
    }
    if (facts.prTitle !== null && !/^chore\(release\): /.test(facts.prTitle)) {
      found.push(
        `the version changed in a pull request titled "${facts.prTitle}"; a release pull request is titled "chore(release): ..."`,
      );
    }
  }
  return found;
}

function root(args: string[]): string {
  const at = args.indexOf("--root");
  return at >= 0 ? (args[at + 1] ?? "") : join(import.meta.dir, "..", "..");
}

function readFields(top: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const file of VERSION_FILES) {
    const match = readFileSync(join(top, file), "utf8").match(VERSION_LINE);
    if (!match) throw new Error(`${file} has no version field`);
    fields[file] = match[2] as string;
  }
  return fields;
}

function bump(top: string, level: string | undefined): number {
  if (!LEVELS.includes(level as Level)) {
    console.error("usage: just release <major|minor|patch>. The owner picks the level.");
    return 2;
  }
  const fields = readFields(top);
  const current = [...new Set(Object.values(fields))];
  if (current.length !== 1) {
    console.error(`the version fields differ: ${JSON.stringify(fields)}`);
    return 1;
  }
  const next = bumpVersion(current[0] as string, level as Level);
  const changelogPath = join(top, "CHANGELOG.md");
  let changelog: string;
  try {
    changelog = moveUnreleased(readFileSync(changelogPath, "utf8"), next, today());
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 1;
  }
  for (const file of VERSION_FILES) {
    const path = join(top, file);
    writeFileSync(path, readFileSync(path, "utf8").replace(VERSION_LINE, `$1${next}$3`));
  }
  writeFileSync(changelogPath, changelog);
  console.log(`${current[0]} -> ${next}`);
  return 0;
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function check(top: string, args: string[]): number {
  const repo = git.locate(top, process.env, 20_000);
  const at = args.indexOf("--base");
  const requested = at >= 0 ? args[at + 1] : undefined;
  const base = repo
    ? [requested, "origin/main", "main"].find((ref) => ref && git.revParse(repo, ref))
    : undefined;
  const baseText = repo && base ? git.show(repo, base, VERSION_FILES[0] as string) : null;
  const facts: Facts = {
    fields: readFields(top),
    baseVersion: baseText?.match(VERSION_LINE)?.[2] ?? null,
    changelog: readFileSync(join(top, "CHANGELOG.md"), "utf8"),
    prTitle: process.env.PR_TITLE ?? null,
  };
  if (facts.baseVersion === null) {
    console.log("release-check: no base ref found; checked the four fields only");
  }
  const problems = failures(facts);
  for (const problem of problems) console.error(`release-check: ${problem}`);

  if (
    repo &&
    problems.length === 0 &&
    facts.baseVersion === facts.fields[VERSION_FILES[0] as string]
  ) {
    const last = git.lastChangeMatching(repo, VERSION_FILES[0] as string, '"version"');
    const changed = last ? git.changedSince(repo, last, SHIPPED) : null;
    if (changed && changed.length > 0) {
      console.warn(
        `release-check: warning: ${changed.length} shipped file(s) changed since the last release (${facts.baseVersion}) and the version stayed the same; hosts cache plugins by version, so the change reaches them only after \`just release <level>\``,
      );
    }
  }
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const top = root(args);
  if (command === "bump")
    process.exit(
      bump(
        top,
        args.find((a) => !a.startsWith("--") && a !== top),
      ),
    );
  else if (command === "check") process.exit(check(top, args));
  else {
    console.error("usage: release.ts bump <major|minor|patch> | check [--base <ref>]");
    process.exit(2);
  }
}
