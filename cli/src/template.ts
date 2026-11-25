/**
 * Template expansion, headless. It follows the core Templates plugin of
 * Obsidian, not Templater: `{{title}}`, `{{date}}`, `{{time}}`, and the
 * `{{date:FORMAT}}` and `{{time:FORMAT}}` forms, with moment.js formats.
 * Any other `{{...}}` text stays as it is. No code from a vault runs.
 *
 * The settings come from the vault's own Obsidian config:
 * `.obsidian/templates.json` (`folder`, `dateFormat`, `timeFormat`) and, for
 * the daily note, `.obsidian/daily-notes.json` (`template`). A missing key
 * takes Obsidian's default. The daily note's folder and file name stay the
 * llmOS layout (`layout.ts`), which the digest and the schema rely on.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import moment from "moment";
import { TEMPLATES_DIR } from "./layout.ts";
import { readText, resolveInVault } from "./vault-file.ts";

export interface TemplateContext {
  /** The new note's name, without `.md`. */
  title: string;
  now: Date;
  /** The format of a bare `{{date}}`. */
  dateFormat: string;
  /** The format of a bare `{{time}}`. */
  timeFormat: string;
}

export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
export const DEFAULT_TIME_FORMAT = "HH:mm";
const DEFAULT_DAILY_TEMPLATE = `${TEMPLATES_DIR}/daily-note`;

export function expandTemplate(text: string, context: TemplateContext): string {
  const when = moment(context.now);
  return text.replace(
    /\{\{(?:(title)|(date|time)(?::([^{}]*))?)\}\}/g,
    (_match, title: string | undefined, kind: string | undefined, format: string | undefined) => {
      if (title !== undefined) return context.title;
      const fallback = kind === "date" ? context.dateFormat : context.timeFormat;
      return when.format(format === undefined || format === "" ? fallback : format);
    },
  );
}

function readConfig(root: string, name: string): Record<string, unknown> {
  const file = `.obsidian/${name}`;
  let raw: string;
  try {
    raw = readFileSync(join(root, file), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return {};
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return data as Record<string, unknown>;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function withExtension(path: string): string {
  return path.endsWith(".md") ? path : `${path}.md`;
}

/** The text of the template at vault-relative `path` (`.md` optional), expanded for a new note. */
function expandFile(root: string, path: string, title: string, now: Date): string {
  const config = readConfig(root, "templates.json");
  const template = readText(resolveInVault(root, withExtension(path)));
  return expandTemplate(template, {
    title,
    now,
    dateFormat: text(config.dateFormat, DEFAULT_DATE_FORMAT),
    timeFormat: text(config.timeFormat, DEFAULT_TIME_FORMAT),
  });
}

/**
 * The text of `create --template NAME`: the template `name` in the vault's
 * templates folder, expanded for the new note called `title`. `name` is a
 * path inside that folder; the caller has refused `..` and absolute paths.
 */
export function expandNamedTemplate(root: string, name: string, title: string): string {
  const folder = trimSlashes(text(readConfig(root, "templates.json").folder, TEMPLATES_DIR));
  return expandFile(root, folder === "" ? name : `${folder}/${name}`, title, new Date());
}

/** The text of a new daily note for `day` (`YYYY-MM-DD`): the daily template, expanded for that day. */
export function expandDailyTemplate(root: string, day: string): string {
  const path = trimSlashes(
    text(readConfig(root, "daily-notes.json").template, DEFAULT_DAILY_TEMPLATE),
  );
  return expandFile(root, path, day, moment(day, "YYYY-MM-DD", true).toDate());
}
