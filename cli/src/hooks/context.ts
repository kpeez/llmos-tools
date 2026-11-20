/**
 * Gated llmOS context for session start and common note-access tools.
 *
 * The configured vault root is the only authority for vault identity.
 * Session start recognizes a cwd inside that root, or a project cwd with an
 * ancestor whose `.agents/docs` or `.agent/docs` symlink leads into it.
 * PreToolUse resolves explicit paths through symlinks before it adds the
 * authoring guidance. Shell coverage is limited to simple, standalone read
 * commands; it is not a shell parser. Shared project memory lives in
 * `projects/<project>/memory/` (ADR-0020); legacy `agents/<provider>/MEMORY.md`
 * is never read.
 */

import { basename } from "node:path";
import {
  AUTHORING_NOTE,
  DAILY_DIR,
  isMemoryNote,
  MEMORY_DIR,
  MEMORY_INDEX,
  SCHEMA_NOTE,
} from "../layout.ts";
import {
  isMcpWriteTool,
  MEMORY_TOOLS as MCP_MEMORY_TOOLS,
  READ_TOOLS as MCP_READ_TOOLS,
  WRITE_TOOLS as MCP_WRITE_TOOLS,
  SERVER_NAME,
} from "../mcp-names.ts";
import { MemoryRefused, memoryScope, readMemoryIndex } from "../memory.ts";
import {
  firstTruthy,
  isDir,
  isFile,
  isOSError,
  isSymlink,
  isUnder,
  joinPath,
  localDate,
  type Payload,
  pathFrom,
  payloadCwd,
  readText,
  resolvedRoot,
  suffix,
  toolInputOf,
  toolNameOf,
  workspacePath,
} from "./common.ts";
import { hookAgent } from "./heartbeat.ts";
import { hasAutoMemoryDir } from "./links.ts";
import { ShlexError, split } from "./shlex.ts";

export { toolInputOf };

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

export interface SessionStartOptions {
  data?: Payload;
  claudeAutoMemoryReady?: boolean;
  /** The session's folder; outside the vault and any linked project it picks the memory scope. */
  cwd?: string | null;
}

/**
 * The shared memory folder of a session: the linked project's, the llmos
 * project's inside the vault (the vault checkout is `llmOS`), and otherwise
 * the scope `memoryScope` gives the folder (`personal` outside a vault project).
 */
function projectMemoryDir(
  root: string,
  linked: [string, string] | null,
  cwd: string | null,
): string | null {
  if (linked === null) {
    if (cwd === null || isUnder(cwd, root)) return joinPath(root, "projects", "llmos", MEMORY_DIR);
    try {
      return joinPath(root, memoryScope(root, cwd).dir);
    } catch (error) {
      if (error instanceof MemoryRefused) return null;
      throw error;
    }
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const target = linked[1];
  if (!target.startsWith(prefix)) return null;
  const rel = target.slice(prefix.length);
  const parts = rel.split("/");
  if (parts[0] !== "projects" || !parts[1]) return null;
  return joinPath(root, "projects", parts[1], MEMORY_DIR);
}

export function sessionContext(
  root: string,
  linked: [string, string] | null,
  options: SessionStartOptions = {},
): string {
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
  const sections = [`${access}${routes}`, daily, MCP_LINE];
  const memoryDir = projectMemoryDir(root, linked, options.cwd ?? null);
  if (memoryDir !== null && isDir(memoryDir)) {
    sections.push(
      `Shared project memory lives in ${memoryDir} (${MEMORY_INDEX} index + <slug>.md topic files ` +
        "with frontmatter name, description, and metadata.type).",
    );
    const provider = hookAgent(process.env, options.data ?? {});
    const autoMemoryReady = options.claudeAutoMemoryReady ?? false;
    const indexPath = joinPath(memoryDir, MEMORY_INDEX);
    if ((provider !== "claude" || !autoMemoryReady) && isFile(indexPath)) {
      const index = readMemoryIndex(indexPath);
      if (index !== null) sections.push(`Shared project memory (${indexPath}):\n${index}`);
    }
  }
  return sections.join("\n");
}

const MCP_LINE =
  `When the ${SERVER_NAME} MCP server is connected, use its tools before Grep, Read, or the ` +
  "llmos CLI: search to find notes about a topic; read with section or " +
  "properties_only when you need one heading or the frontmatter, not the whole note; list " +
  "with a folder for the properties of every note there; neighbors or subgraph for links; " +
  "set_property to change one property. All tools: " +
  `${MCP_READ_TOOLS.join(", ")} to look notes up; ${MCP_WRITE_TOOLS.join(", ")} to write ` +
  `(they stamp updated themselves); ${MCP_MEMORY_TOOLS.join(", ")} for shared project memory.`;

export function sessionStart(data: Payload, options: SessionStartOptions = {}): string | null {
  const root = resolvedRoot();
  if (root === null) return null;
  const cwd = payloadCwd(data) ?? pathFrom(process.cwd());
  if (cwd === null) return null;
  const inside = isUnder(cwd, root);
  const linked = inside ? null : linkedProjectDocs(cwd, root);
  if (!inside && linked === null) return null;
  const claudeAutoMemoryReady = options.claudeAutoMemoryReady ?? hasAutoMemoryDir(cwd, root);
  return sessionContext(root, linked, { data, claudeAutoMemoryReady, cwd });
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
    "frontmatter (`name`, `description`, `metadata.type`, and `metadata.node_type: memory`). " +
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
