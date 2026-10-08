/**
 * The llmOS profile's frontmatter contract checks, shared by the audit and
 * the schema-violations section of the health report. A plain vault such as
 * second-vault has no schema layer and never calls this module.
 *
 * The rules are those of the retired Python schema module; a message
 * quotes a property value as JSON (Python wrote its `repr`). Nested values,
 * which only the TypeScript reader accepts, are checked by the same rules: a
 * map is empty when it has no keys, and anything that is not a string fails
 * a string rule.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PropertyValue } from "./frontmatter.ts";
import { type BrokenLink, comparePaths, type Note, readText, type VaultModel } from "./vault.ts";

// ADRs use proposed/accepted/superseded; other notes use the rest.
export const STATUSES = new Set([
  "draft",
  "active",
  "review",
  "done",
  "archived",
  "proposed",
  "accepted",
  "superseded",
]);
export const AUTHORS = new Set(["claude", "codex", "gemini", "human"]);
export const LINK_FIELDS = ["categories", "project", "topics"] as const;
const WIKILINK = /^"?\[\[[^\]]+\]\]"?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Display alias for a project link: the landing page's H1, else the slug. */
export function projectAlias(root: string, slug: string): string {
  const landing = join(root, "projects", slug, `${slug}.md`);
  if (existsSync(landing) && statSync(landing).isFile()) {
    for (const line of readText(landing).split("\n")) {
      if (line.startsWith("# ")) return line.slice(2).trim();
    }
  }
  return slug;
}

/**
 * Markdown files git sees as untracked under `root`, relative to it; empty
 * when `root` is not in a repository. `-z` gives the paths unquoted, so a
 * non-ASCII name is not lost to git's quoting.
 */
export function untrackedMarkdown(root: string): Set<string> {
  const result = Bun.spawnSync(
    ["git", "-C", root, "ls-files", "-z", "--others", "--exclude-standard"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) return new Set();
  return new Set(
    result.stdout
      .toString()
      .split("\0")
      .filter((path) => path.endsWith(".md")),
  );
}

function isEmpty(value: PropertyValue | undefined): boolean {
  if (value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

export interface SchemaReport {
  errors: string[];
  checked: number;
}

function skipped(parts: string[]): boolean {
  return (
    parts[0] === "templates" ||
    (parts[0] === "archive" && parts[1] === "specs") ||
    parts.some((part) => part.startsWith("."))
  );
}

/** The schema-violation messages for one note's properties. */
function noteErrors(relative: string, note: Note, newNotes: Set<string>): string[] {
  const errors: string[] = [];
  const parts = relative.split("/");
  const properties = note.properties;

  const isDailyReview = parts[0] === "reviews" && parts[1] === "daily";
  if (newNotes.has(relative) || isDailyReview) {
    const created = properties.created;
    if (typeof created !== "string" || !ISO_DATE.test(created)) {
      errors.push(`${relative}: created must be an ISO date`);
    }
  }
  if (isDailyReview && "project" in properties) {
    errors.push(`${relative}: daily reviews must not claim project ownership`);
  }

  // Operational properties are optional; validate only when present.
  const status = properties.status;
  if (status !== undefined && (typeof status !== "string" || !STATUSES.has(status))) {
    errors.push(`${relative}: invalid status ${JSON.stringify(status)}`);
  }

  const authors = properties.authors;
  if (authors !== undefined) {
    if (
      !Array.isArray(authors) ||
      authors.some((value) => typeof value !== "string" || !AUTHORS.has(value))
    ) {
      errors.push(`${relative}: authors must be a canonical list`);
    }
  }

  for (const forbidden of ["kind", "type", "related", "sources"]) {
    if (forbidden in properties) errors.push(`${relative}: contains retired property ${forbidden}`);
  }
  for (const [key, value] of Object.entries(properties)) {
    if (isEmpty(value)) {
      errors.push(`${relative}: property ${key} is empty`);
    } else if (Array.isArray(value) && value.some((item) => item === "")) {
      errors.push(`${relative}: property ${key} contains empty value`);
    }
  }

  for (const field of LINK_FIELDS) {
    const values = properties[field];
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      errors.push(`${relative}: ${field} must be a list`);
      continue;
    }
    for (const value of values) {
      if (typeof value !== "string" || !WIKILINK.test(value)) {
        errors.push(`${relative}: ${field} contains non-wikilink ${JSON.stringify(value)}`);
      }
    }
  }

  const name = parts[parts.length - 1];
  const isProjectEntrypoint =
    parts.length === 3 && parts[0] === "projects" && name === `${parts[1]}.md`;
  const isProjectOwned = parts.length >= 3 && parts[0] === "projects" && !isProjectEntrypoint;
  if (isProjectOwned && isEmpty(properties.project)) {
    errors.push(`${relative}: project-owned note lacks project link`);
  }
  return errors;
}

/**
 * Check every note in the model against the llmOS property contract and
 * return the violation messages and the number of notes checked. Templates,
 * retired specs, and anything under a dot folder are skipped.
 */
export function collectErrors(model: VaultModel): SchemaReport {
  const errors: string[] = [];
  let checked = 0;
  const newNotes = untrackedMarkdown(model.root);
  const entries: (Note | BrokenLink)[] = [...model.notes, ...model.brokenLinks].sort((a, b) =>
    comparePaths(a.path, b.path),
  );
  for (const entry of entries) {
    const relative = entry.path;
    const parts = relative.split("/");
    if (skipped(parts)) continue;
    if (!("text" in entry)) {
      // A broken symlink is a vault defect, not a schema one; report and move on.
      errors.push(`${relative}: broken symlink -> ${entry.target}`);
      continue;
    }
    if (entry.frontmatterError) {
      errors.push(`${relative}: unsupported frontmatter: ${entry.frontmatterError.message}`);
      checked += 1;
      continue;
    }
    const hasFrontmatter = entry.hasFrontmatter;
    if (parts[parts.length - 1] === "SKILL.md" && parts.includes("skills")) {
      if (
        !hasFrontmatter ||
        isEmpty(entry.properties.name) ||
        isEmpty(entry.properties.description)
      ) {
        errors.push(`${relative}: invalid skill frontmatter`);
      }
      continue;
    }
    if (!hasFrontmatter) {
      errors.push(`${relative}: missing frontmatter`);
      checked += 1;
      continue;
    }
    checked += 1;
    errors.push(...noteErrors(relative, entry, newNotes));
  }
  return { errors, checked };
}
