/**
 * The session-start context: where the vault is, the shared project memory
 * of the session, and the MCP tool list. Only `session-start` loads this
 * file: it pulls in the memory code, which the hot `pre-tool-use` bundle must
 * not carry (see `src/hooks/context.ts` for the tool-call context).
 */

import { basename, dirname } from "node:path";
import { AUTHORING_NOTE, DAILY_DIR, MEMORY_DIR, MEMORY_INDEX, SCHEMA_NOTE } from "../layout.ts";
import {
  MEMORY_TOOLS as MCP_MEMORY_TOOLS,
  READ_TOOLS as MCP_READ_TOOLS,
  WRITE_TOOLS as MCP_WRITE_TOOLS,
  SERVER_NAME,
} from "../mcp-names.ts";
import { MemoryRefused, memoryScope, readMemoryIndex } from "../memory.ts";
import {
  isDir,
  isFile,
  isSymlink,
  isUnder,
  joinPath,
  localDate,
  type Payload,
  pathFrom,
  payloadCwd,
  resolvedRoot,
} from "./common.ts";
import { hookAgent } from "./heartbeat.ts";
import { hasAutoMemoryDir } from "./links.ts";

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
  /** The hook process's folder, for a session start whose payload names none. */
  processCwd?: string | null;
  /** An agent's memory provider already puts the index in its prompt (Hermes's llmos provider). */
  memoryIndexLoaded?: boolean;
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
        "with frontmatter name, description, and metadata.type). " +
        `Pass project: "${basename(dirname(memoryDir))}" to the memory tools.`,
    );
    const provider = hookAgent(process.env, options.data ?? {});
    const autoMemoryReady = options.claudeAutoMemoryReady ?? false;
    const indexPath = joinPath(memoryDir, MEMORY_INDEX);
    const loaded = options.memoryIndexLoaded ?? false;
    if (!loaded && (provider !== "claude" || !autoMemoryReady) && isFile(indexPath)) {
      const index = readMemoryIndex(root, indexPath);
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
  const cwd = payloadCwd(data) ?? options.processCwd ?? null;
  if (cwd === null) return null;
  const inside = isUnder(cwd, root);
  const linked = inside ? null : linkedProjectDocs(cwd, root);
  if (!inside && linked === null) return null;
  const claudeAutoMemoryReady = options.claudeAutoMemoryReady ?? hasAutoMemoryDir(cwd, root);
  return sessionContext(root, linked, { ...options, data, claudeAutoMemoryReady, cwd });
}
