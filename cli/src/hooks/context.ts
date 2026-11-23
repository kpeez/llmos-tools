/**
 * Gated llmOS context for common note-access tools (PreToolUse).
 *
 * The configured vault root is the only authority for vault identity.
 * PreToolUse resolves explicit paths through symlinks before it adds the
 * authoring guidance. Shell coverage is limited to simple, standalone read
 * commands; it is not a shell parser. The session-start context lives in
 * `session-context.ts`; this file loads no memory or vault-model code, so
 * the `pre-tool-use` bundle stays small.
 */

import { basename } from "node:path";
import { AUTHORING_NOTE, isMemoryNote, SCHEMA_NOTE } from "../layout.ts";
import { isMcpWriteTool } from "../mcp-names.ts";
import {
  firstTruthy,
  isDir,
  isFile,
  isOSError,
  isUnder,
  joinPath,
  type Payload,
  pathFrom,
  readText,
  resolvedRoot,
  suffix,
  toolInputOf,
  toolNameOf,
  workspacePath,
} from "./common.ts";
import { ShlexError, split } from "./shlex.ts";

const NOTE_SUFFIXES = new Set([".md", ".base", ".canvas"]);
const PATCH_VERBS = ["*** Update File:", "*** Add File:", "*** Delete File:"];
const SHELL_READERS = new Set(["cat", "head", "tail", "sed", "rg", "grep"]);
const VAULT_READ_COMMANDS = new Set(["read", "list", "check", "neighbors", "subgraph", "health"]);
const SHELL_MARKERS = ["\n", ";", "|", "&", ">", "<", "`", "$(", "${"];
const DIRECTORY_TOOLS = new Set([
  "Grep",
  "Glob",
  "LS",
  "Bash",
  "grep_search",
  "find_by_name",
  "run_command",
]);
const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "apply_patch",
  "write_file",
  "edit_file",
]);
const MAX_AUTHORING_CONTEXT_CHARS = 8_000;
const SKILL_NAMES: Record<string, string> = {
  ".md": "obsidian-markdown",
  ".base": "obsidian-bases",
  ".canvas": "json-canvas",
};

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
  if (executable === "llmos") {
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
  for (const key of [
    "file_path",
    "path",
    "notebook_path",
    "Path",
    "TargetFile",
    "SearchDirectory",
    "Directory",
    "AbsolutePath",
  ]) {
    const value = toolInput[key];
    if (typeof value === "string") raw.push(value);
  }
  const command = firstTruthy([toolInput.command, toolInput.CommandLine], undefined);
  if (typeof command === "string") {
    raw.push(...patchPaths(command));
    if ((options.toolName === "Bash" || options.toolName === "run_command") && options.root) {
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
    "embeds, and local context. Use `llmos read`/`neighbors` or qmd " +
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

function memoryWriteContext(): string {
  return (
    "Shared project memory (projects/<project>/memory/): keep MEMORY.md as a concise " +
    "index under 200 lines without YAML frontmatter; write topic .md files with YAML " +
    "frontmatter (`name`, `description`, and `metadata.type`). " +
    "Do not add durable-vault `categories`, `created`, or `project` properties."
  );
}

export function preToolUse(data: Payload): string | null {
  const root = resolvedRoot();
  if (root === null) return null;
  const toolName = toolNameOf(data);
  const toolInput = toolInputOf(data);
  // An llmOS MCP write tool names no file; it always writes vault notes.
  if (isMcpWriteTool(toolName, toolInput)) {
    return withSchema(root, writeContext(root, [joinPath(root, "note.md")]));
  }
  if (toolInput === null) return null;
  const cwd = firstTruthy([data.cwd, workspacePath(data)], undefined);
  const targets = targetPaths(toolInput, { cwd, toolName, root });
  const relevant = targets.filter(
    (target) =>
      isUnder(target, root) &&
      (NOTE_SUFFIXES.has(suffix(target)) || (DIRECTORY_TOOLS.has(toolName) && isDir(target))),
  );
  if (relevant.length === 0) return null;

  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  const durableTargets: string[] = [];
  const memoryTargets: string[] = [];
  for (const target of relevant) {
    const relative = target === root ? "" : target.slice(rootPrefix.length);
    if (isMemoryNote(relative)) memoryTargets.push(target);
    else durableTargets.push(target);
  }

  // An empty tool name keeps older Codex payloads working: they carry a
  // path but no tool_name, and their path is the write target.
  const writeIntent = WRITE_TOOLS.has(toolName) || !toolName;
  if (durableTargets.length === 0) {
    return writeIntent ? memoryWriteContext() : null;
  }
  if (!writeIntent) return readContext(root);
  const context = writeContext(root, durableTargets);
  const body = durableTargets.some((target) => suffix(target) === ".md")
    ? withSchema(root, context)
    : context;
  return memoryTargets.length > 0 ? `${body}\n\n${memoryWriteContext()}` : body;
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
