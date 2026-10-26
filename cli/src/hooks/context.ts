/**
 * Gated llmOS context for session start and common note-access tools.
 *
 * The configured vault root is the only authority for vault identity.
 * Session start recognizes a cwd inside that root, or a project cwd with an
 * ancestor whose `.agents/docs` or `.agent/docs` symlink leads into it.
 * PreToolUse resolves explicit paths through symlinks before it adds the
 * authoring guidance. Shell coverage is limited to simple, standalone read
 * commands; it is not a shell parser. No provider MEMORY.md is read
 * (ADR-0003).
 */

import { basename } from "node:path";
import { AUTHORING_NOTE, DAILY_DIR, SCHEMA_NOTE } from "../layout.ts";
import {
  READ_TOOLS as MCP_READ_TOOLS,
  MCP_WRITE_TOOL,
  WRITE_TOOLS as MCP_WRITE_TOOLS,
  SERVER_NAME,
} from "../mcp-names.ts";
import {
  firstTruthy,
  isDict,
  isDir,
  isFile,
  isOSError,
  isSymlink,
  isUnder,
  joinPath,
  localDate,
  type Payload,
  pathFrom,
  readText,
  resolvedRoot,
  suffix,
} from "./common.ts";
import { ShlexError, split } from "./shlex.ts";

const NOTE_SUFFIXES = new Set([".md", ".base", ".canvas"]);
const PATCH_VERBS = ["*** Update File:", "*** Add File:", "*** Delete File:"];
const SHELL_READERS = new Set(["cat", "head", "tail", "sed", "rg", "grep"]);
const VAULT_READ_COMMANDS = new Set(["read", "list", "check", "neighbors", "subgraph", "health"]);
const SHELL_MARKERS = ["\n", ";", "|", "&", ">", "<", "`", "$(", "${"];
const DIRECTORY_TOOLS = new Set(["Grep", "Glob", "LS", "Bash"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "apply_patch"]);
const MAX_AUTHORING_CONTEXT_CHARS = 8_000;
const SKILL_NAMES: Record<string, string> = {
  ".md": "obsidian-markdown",
  ".base": "obsidian-bases",
  ".canvas": "json-canvas",
};

/** `cwd`, then each parent up to `/`. */
function* ancestors(path: string): Generator<string> {
  let current = path;
  for (;;) {
    yield current;
    if (current === "/") return;
    const cut = current.lastIndexOf("/");
    current = cut <= 0 ? "/" : current.slice(0, cut);
  }
}

/** The linked docs folder and its target, for a cwd inside a project repository. */
function linkedProjectDocs(cwd: string, root: string): [string, string] | null {
  for (const ancestor of ancestors(cwd)) {
    for (const dotDirectory of [".agents", ".agent"]) {
      const folder = joinPath(ancestor, dotDirectory);
      const candidate = joinPath(folder, "docs");
      try {
        if (!isDir(candidate)) continue;
        const target = pathFrom(candidate);
        if (target === null) continue;
        if ((isSymlink(candidate) || isSymlink(folder)) && isUnder(target, root)) {
          return [candidate, target];
        }
      } catch {}
    }
  }
  return null;
}

export function sessionContext(root: string, linked: [string, string] | null): string {
  const routes =
    `For durable vault work, read ${joinPath(root, "AGENTS.md")}, ` +
    `${joinPath(root, SCHEMA_NOTE)}, and ${joinPath(root, AUTHORING_NOTE)}.`;
  const access = linked
    ? `This project session reaches llmOS through ${linked[0]} ` +
      `(resolves to ${linked[1]}). Treat those files as Obsidian vault notes. `
    : `llmOS root: ${root}. `;
  const daily =
    `Insight worth keeping goes under ## Thoughts in ` +
    `${joinPath(root, DAILY_DIR, `${localDate()}.md`)} -- prose only, and never a ` +
    "restatement of commits, issues, or PRs, which GitHub already records.";
  return `${access}${routes}\n${daily}\n${MCP_LINE}`;
}

const MCP_LINE =
  `When the ${SERVER_NAME} MCP server is connected, use its tools before Grep, Read, or the ` +
  "llmos-vault CLI: search to find notes about a topic; read with section or " +
  "properties_only when you need one heading or the frontmatter, not the whole note; list " +
  "with a folder for the properties of every note there; neighbors or subgraph for links; " +
  "set_property to change one property. All tools: " +
  `${MCP_READ_TOOLS.join(", ")} to look notes up; ${MCP_WRITE_TOOLS.join(", ")} to write ` +
  "(they stamp updated and authors themselves).";

export function sessionStart(data: Payload): string | null {
  const root = resolvedRoot();
  if (root === null) return null;
  const cwd = pathFrom(data.cwd) ?? pathFrom(process.cwd());
  if (cwd === null) return null;
  const inside = isUnder(cwd, root);
  const linked = inside ? null : linkedProjectDocs(cwd, root);
  if (!inside && linked === null) return null;
  return sessionContext(root, linked);
}

function patchPaths(command: string): string[] {
  const found: string[] = [];
  for (const line of command.split(/\r\n|\r|\n/)) {
    if (PATCH_VERBS.some((verb) => line.startsWith(verb))) {
      found.push(line.slice(line.indexOf(":") + 1).trim());
    }
  }
  return found;
}

/**
 * Explicit paths in a small allowlist of simple shell reads. Compound
 * commands and shell expansion are ignored on purpose: parsing arbitrary
 * shell syntax here would be unreliable.
 */
function simpleShellPaths(command: string, root: string): string[] {
  if (SHELL_MARKERS.some((marker) => command.includes(marker))) return [];
  let tokens: string[];
  try {
    tokens = split(command);
  } catch (error) {
    if (error instanceof ShlexError) return [];
    throw error;
  }
  if (tokens.length === 0) return [];

  const executable = basename(tokens[0] as string);
  const args = tokens.slice(1);
  if (executable === "llmos-vault") {
    if (args[0] === "daily") {
      if (args[1] !== "recent") return [];
    } else if (args.length === 0 || !VAULT_READ_COMMANDS.has(args[0] as string)) {
      return [];
    }
    let vaultName = "llmos";
    for (const [index, argument] of args.entries()) {
      if (argument === "--vault") {
        if (index + 1 < args.length) vaultName = args[index + 1] as string;
        break;
      }
      if (argument.startsWith("--vault=")) {
        vaultName = argument.slice("--vault=".length);
        break;
      }
    }
    return vaultName === "llmos" ? [root] : [];
  }
  if (!SHELL_READERS.has(executable)) return [];

  let positional = args.filter((argument) => !argument.startsWith("-"));
  // rg and grep take the search expression before their optional paths.
  if ((executable === "rg" || executable === "grep") && !args.includes("--files")) {
    positional = positional.slice(1);
  }
  return positional;
}

/** Explicit target paths of a harness payload, resolved through symlinks. */
export function targetPaths(
  toolInput: Payload,
  options: { cwd?: unknown; toolName?: string; root?: string | null },
): string[] {
  const raw: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = toolInput[key];
    if (typeof value === "string") raw.push(value);
  }
  const command = toolInput.command;
  if (typeof command === "string") {
    raw.push(...patchPaths(command));
    if (options.toolName === "Bash" && options.root) {
      raw.push(...simpleShellPaths(command, options.root));
    }
  }
  const resolved: string[] = [];
  for (const value of raw) {
    const path = pathFrom(value, options.cwd);
    if (path !== null) resolved.push(path);
  }
  return resolved;
}

/** The payload's `tool_input` (or Codex's older `input`) object, if any. */
export function toolInputOf(data: Payload): Payload | null {
  const toolInput = firstTruthy([data.tool_input, data.input], {});
  return isDict(toolInput) ? toolInput : null;
}

function authoringContext(root: string): string {
  const authoring = joinPath(root, AUTHORING_NOTE);
  if (!isFile(authoring)) {
    return (
      "llmOS notes are Obsidian notes: use [[wikilinks]] for internal links, " +
      "connect new notes to relevant existing notes, and use Bases or Canvas " +
      "when they improve browsing. See the canonical authoring contract at " +
      `${authoring}.`
    );
  }
  let text: string;
  try {
    text = readText(authoring).trim();
  } catch (error) {
    if (isOSError(error)) return `Follow the canonical llmOS authoring contract at ${authoring}.`;
    throw error;
  }
  // Count characters, not UTF-16 units, so the cut never splits an emoji.
  const chars = text.length > MAX_AUTHORING_CONTEXT_CHARS ? Array.from(text) : [];
  if (chars.length > MAX_AUTHORING_CONTEXT_CHARS) {
    const head = chars.slice(0, MAX_AUTHORING_CONTEXT_CHARS).join("").trimEnd();
    text = `${head}\n[authoring guidance truncated]`;
  }
  return `Canonical llmOS Obsidian authoring guidance (${authoring}):\n${text}`;
}

function readContext(root: string): string {
  const authoring = joinPath(root, AUTHORING_NOTE);
  return (
    "This is an Obsidian vault note. Preserve its frontmatter, wikilinks, " +
    "embeds, and local context. Use `llmos-vault read`/`neighbors` or qmd " +
    "for retrieval. Before editing, use `maintain-llmos`/`vault-cli` when " +
    `available and check ${authoring}.`
  );
}

function writeContext(root: string, targets: string[]): string {
  const skills = new Set<string>();
  for (const target of targets) {
    const skill = SKILL_NAMES[suffix(target)];
    if (skill) skills.add(skill);
  }
  const routing =
    "Use `maintain-llmos`/`vault-cli` when available; use the installed " +
    "Obsidian skill for the file type when available: " +
    [...skills]
      .sort()
      .map((name) => `\`${name}\``)
      .join(", ") +
    ".";
  return `${authoringContext(root)}\n\n${routing}`;
}

function toolNameOf(data: Payload): string {
  const name = firstTruthy([data.tool_name, data.name], "");
  return typeof name === "string" ? name : "";
}

export function preToolUse(data: Payload): string | null {
  const root = resolvedRoot();
  if (root === null) return null;
  const toolName = toolNameOf(data);
  // An llmOS MCP write tool names no file; it always writes vault notes.
  if (MCP_WRITE_TOOL.test(toolName)) {
    return withSchema(root, writeContext(root, [joinPath(root, "note.md")]));
  }
  const toolInput = toolInputOf(data);
  if (toolInput === null) return null;
  const targets = targetPaths(toolInput, { cwd: data.cwd, toolName, root });
  const relevant = targets.filter(
    (target) =>
      isUnder(target, root) &&
      (NOTE_SUFFIXES.has(suffix(target)) || (DIRECTORY_TOOLS.has(toolName) && isDir(target))),
  );
  if (relevant.length === 0) return null;

  // An empty tool name keeps older Codex payloads working: they carry a
  // path but no tool_name, and their path is the write target.
  const writeIntent = WRITE_TOOLS.has(toolName) || !toolName;
  if (!writeIntent) return readContext(root);
  const context = writeContext(root, relevant);
  return relevant.some((target) => suffix(target) === ".md") ? withSchema(root, context) : context;
}

/** `context` after the vault's note schema, when the schema file can be read. */
function withSchema(root: string, context: string): string {
  const schema = joinPath(root, SCHEMA_NOTE);
  if (!isFile(schema)) return context;
  try {
    return `${readText(schema).trim()}\n\n${context}`;
  } catch (error) {
    if (!isOSError(error)) throw error;
    return context;
  }
}
