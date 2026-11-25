/**
 * `llmos fmt`: format notes with the rules of the Obsidian Linter plugin
 * (https://github.com/platers/obsidian-linter, MIT), using the vault's own
 * Linter settings, so a note the CLI formats matches what lint-on-save would
 * write in Obsidian.
 *
 * The plugin is the `obsidian-linter` GitHub dependency pinned to the commit of one
 * release (`package.json`). `fmt` refuses to run when the vault's Obsidian has
 * another Linter release installed (`checkLinterVersion`). Its rules are plain TypeScript, but they import the
 * `obsidian` package, which exists only inside the app. `loadLinter` registers
 * a stub for that import and then loads the rules at run time, so the linter
 * is in no committed bundle (the hooks and the MCP launcher never reach this
 * module's linter import).
 *
 * This module is outside the vault-read lint list (`biome.json`) on purpose:
 * the settings file lives in `.obsidian/`, which `resolveInVault` refuses.
 * Notes still go through `resolveInVault` and `readText`, and a write goes
 * through `rewriteNote` (`write.ts`) under the note lock.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { plugin } from "bun";
import { walkVault } from "./vault.ts";
import { readText, resolveInVault, WriteRefused } from "./vault-file.ts";
import { rewriteNote } from "./write.ts";

/** Where the Linter plugin keeps its settings, relative to the vault root. */
export const LINTER_SETTINGS = ".obsidian/plugins/obsidian-linter/data.json";

/** Where the installed Linter plugin names its release, relative to the vault root. */
export const LINTER_MANIFEST = ".obsidian/plugins/obsidian-linter/manifest.json";

/** Notes under this folder are captured sources, which no agent edits. */
const FROZEN_FOLDER = "raw/";

/** The names the rules import from `obsidian`; the stub gives each an empty class. */
const OBSIDIAN_NAMES = [
  "AbstractInputSuggest",
  "App",
  "ButtonComponent",
  "Command",
  "DropdownComponent",
  "Editor",
  "EditorSuggest",
  "EventRef",
  "ExtraButtonComponent",
  "ItemView",
  "MarkdownView",
  "Menu",
  "Modal",
  "Notice",
  "Platform",
  "Plugin",
  "PluginSettingTab",
  "Setting",
  "TAbstractFile",
  "TExternalFile",
  "TFile",
  "TFolder",
  "TextComponent",
  "ToggleComponent",
  "Vault",
  "View",
  "WorkspaceLeaf",
  "addIcon",
  "debounce",
  "displayTooltip",
  "getLanguage",
  "htmlToMarkdown",
  "requestUrl",
  "setIcon",
];

interface LinterSettings {
  foldersToIgnore?: string[];
  filesToIgnore?: { match?: string; flags?: string }[];
}

/** The options of one run of the plugin's rule runner (opaque to `fmt`). */
type RunOptions = object;

/** The slice of the plugin's rule runner that `fmt` calls. */
export interface Linter {
  defaults: Record<string, unknown>;
  /** Each rule's options with their default values, by rule alias. */
  ruleDefaults: Record<string, Record<string, unknown>>;
  lint(text: string, settings: Record<string, unknown>): string;
}

/** The most passes of the rules over one note. */
const MAX_PASSES = 5;

/**
 * The note text after the rules run again and again until a pass changes
 * nothing. One pass of the plugin is not idempotent: a rule can create what an
 * earlier rule in the same pass would have fixed. Obsidian's next lint-on-save
 * finishes the job, so `fmt` finishes it now. Throws when the text still
 * changes after `MAX_PASSES` passes.
 */
export function settle(text: string, pass: (text: string) => string): string {
  let current = text;
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = pass(current);
    if (next === current) return current;
    current = next;
  }
  throw new Error(`Linter output did not settle after ${MAX_PASSES} passes`);
}

let linter: Promise<Linter> | undefined;

/** The plugin's rule runner and default settings, loaded once. */
export function loadLinter(): Promise<Linter> {
  linter ??= importLinter();
  return linter;
}

async function importLinter(): Promise<Linter> {
  const moment = (await import("moment")).default;
  plugin({
    name: "obsidian-stub",
    setup(build) {
      build.module("obsidian", () => ({
        exports: {
          ...Object.fromEntries(OBSIDIAN_NAMES.map((name) => [name, class {}])),
          moment,
          normalizePath: (path: string) => path,
          sanitizeHTMLToDom: () => null,
        },
        loader: "object",
      }));
    },
  });
  // A computed path keeps `bun build` from bundling the plugin.
  const root = dirname(Bun.resolveSync("obsidian-linter/package.json", import.meta.dir));
  const load = <T>(path: string): Promise<T> => import(join(root, path));
  const { DEFAULT_SETTINGS } = await load<{ DEFAULT_SETTINGS: Record<string, unknown> }>(
    "src/settings-data.ts",
  );
  // The plugin finds its rules with a bundler glob; load each file instead.
  for (const file of new Bun.Glob("src/rules/*.ts").scanSync(root)) await load(file);
  const { RulesRunner, createRunLinterRulesOptions } = await load<{
    RulesRunner: new () => { lintText(options: RunOptions): string };
    createRunLinterRulesOptions(
      text: string,
      file: null,
      locale: string,
      settings: Record<string, unknown>,
      misspellings: Map<string, string>,
    ): RunOptions;
  }>("src/rules-runner.ts");
  const { rules } = await load<{
    rules: { alias: string; getDefaultOptions(): Record<string, unknown> }[];
  }>("src/rules.ts");
  return {
    defaults: DEFAULT_SETTINGS,
    ruleDefaults: Object.fromEntries(rules.map((rule) => [rule.alias, rule.getDefaultOptions()])),
    lint(text, settings) {
      const options = createRunLinterRulesOptions(text, null, "en", settings, new Map());
      return new RulesRunner().lintText(options);
    },
  };
}

function manifestVersion(path: string): string {
  const data = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof data.version !== "string" || data.version === "") throw new Error("no version");
  return data.version;
}

/**
 * Throws unless the Linter release in the vault's Obsidian is the release that
 * `fmt` runs. Another release can format differently, so the CLI and
 * lint-on-save would drift apart.
 */
export function checkLinterVersion(root: string): void {
  const ours = manifestVersion(
    join(
      dirname(Bun.resolveSync("obsidian-linter/package.json", import.meta.dir)),
      "manifest.json",
    ),
  );
  let theirs: string;
  try {
    theirs = manifestVersion(join(root, LINTER_MANIFEST));
  } catch {
    throw new Error(
      `cannot read the Linter version from ${LINTER_MANIFEST}, so llmos fmt cannot tell whether Obsidian has Linter ${ours}: install Linter ${ours} in Obsidian`,
    );
  }
  if (theirs !== ours) {
    throw new Error(
      `Obsidian has Linter ${theirs} but llmos fmt has ${ours}: pin cli/package.json to the matching release commit, or install Linter ${ours} in Obsidian`,
    );
  }
}

/** The vault's Linter settings on top of the plugin's defaults. Throws when the vault has none. */
function readSettings(root: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(join(root, LINTER_SETTINGS), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    throw new Error(
      `this vault has no Obsidian Linter settings (${LINTER_SETTINGS}); install the plugin and save its settings once`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${LINTER_SETTINGS} is not valid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${LINTER_SETTINGS} is not a JSON object`);
  }
  return data as Record<string, unknown>;
}

/** Why `fmt` leaves the note at `path` alone, or undefined when it formats it. */
function skipReason(path: string, settings: LinterSettings): string | undefined {
  if (path.startsWith(FROZEN_FOLDER)) return "captured source";
  for (const folder of settings.foldersToIgnore ?? []) {
    const prefix = `${folder.replace(/^\/+|\/+$/g, "")}/`;
    if (prefix !== "/" && path.startsWith(prefix)) return "in the Linter's folders to ignore";
  }
  for (const { match, flags } of settings.filesToIgnore ?? []) {
    if (match && new RegExp(match, flags).test(path)) return "in the Linter's files to ignore";
  }
  return undefined;
}

export interface FmtReport {
  check: boolean;
  /** Notes that `fmt` looked at. */
  linted: number;
  /** Notes the Linter changes (`check`) or changed. */
  changed: string[];
  /** Notes left alone: captured sources and the Linter's ignored folders and files. */
  skipped: number;
  /** Notes the linter or the write refused. */
  failed: { path: string; error: string }[];
}

/** The notes the caller named: a note path (".md" optional) or a folder of notes. */
function selected(all: string[], given: string[]): string[] {
  const chosen = new Set<string>();
  for (const path of given) {
    const bare = path.replace(/^\.\//, "").replace(/\/+$/, "");
    const hits = all.filter(
      (note) => note === bare || note === `${bare}.md` || note.startsWith(`${bare}/`),
    );
    if (hits.length === 0)
      throw new WriteRefused(`'${path}' is not a note or a folder of notes in the vault`);
    for (const hit of hits) chosen.add(hit);
  }
  return [...chosen];
}

/**
 * Format the notes at `given` (vault-relative note or folder paths; all
 * notes when empty). With `check` nothing is written.
 */
export async function formatNotes(
  root: string,
  given: string[],
  check: boolean,
): Promise<FmtReport> {
  checkLinterVersion(root);
  const data = readSettings(root);
  const { defaults, ruleDefaults, lint } = await loadLinter();
  const settings = { ...defaults, ...data };
  const configured = (settings.ruleConfigs ?? {}) as Record<string, unknown>;
  const missing = Object.keys(ruleDefaults).filter((alias) => !(alias in configured));
  if (missing.length > 0) {
    throw new Error(
      `${LINTER_SETTINGS} has no options for ${missing.length} rule(s), such as ${missing[0]}; open the Linter settings in Obsidian once to save them`,
    );
  }
  const all = walkVault(root).filter((path) => path.endsWith(".md"));
  const report: FmtReport = { check, linted: 0, changed: [], skipped: 0, failed: [] };
  for (const path of given.length === 0 ? all : selected(all, given)) {
    if (skipReason(path, data as LinterSettings) !== undefined) {
      report.skipped++;
      continue;
    }
    report.linted++;
    try {
      if (check) {
        const text = readText(resolveInVault(root, path));
        if (settle(text, (t) => lint(t, settings)) !== text) report.changed.push(path);
      } else if (rewriteNote(root, path, (text) => settle(text, (t) => lint(t, settings)))) {
        report.changed.push(path);
      }
    } catch (error) {
      report.failed.push({ path, error: (error as Error).message });
    }
  }
  return report;
}
