/**
 * `llmos mcp`: the llmOS vault tools as an MCP server on stdio, built
 * on the official TypeScript MCP SDK. The plugin's `.mcp.json` starts it
 * through the launcher `dist/mcp.js` (`src/mcp-launcher.ts`).
 *
 * Each tool calls a handler of the CLI command registry (`commands.ts`), and
 * its description and parameter help come from that command, so help text
 * has one source. The server keeps one vault model, loaded again only when
 * a note's file changes on disk (other sessions and tools edit the vault
 * too). Its qmd work (`search`, `memory_search`) goes to the llmOS service
 * (`service.ts`), which keeps the search models loaded for every session on
 * the host; this server starts the service when it finds none. With the
 * service down, the server uses its own qmd store, as it did before the
 * service existed, and the models of a semantic search stay loaded between
 * calls.
 *
 * Tool arguments come from a model and may be hostile. Each handler checks
 * its arguments against the tool's schema again, every note argument must
 * resolve to a note whose real path (symbolic links resolved) is inside the
 * real vault root, and every write goes through the containment checks of
 * `write.ts`. Only the llmOS vault and its `llmos` qmd collection are
 * served. There is no shell, move, create, or arbitrary-file tool.
 *
 * The write tools stamp `updated` on each note they change,
 * because the PostToolUse stamp hook reads only `Write`-style tool inputs.
 */

import { existsSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { QMDStore } from "@tobilu/qmd";
import * as z from "zod";
import type { Command, Context, Outcome, Values } from "./cli.ts";
import { COMMANDS, searchMode } from "./commands.ts";
import { DAILY_DIR } from "./layout.ts";
import { SERVER_NAME } from "./mcp-names.ts";
import {
  forgetMemory,
  MEMORY_TYPES,
  type MemoryInput,
  MemoryRefused,
  type MemoryScope,
  memoryScope,
  projectScope,
  saveMemory,
} from "./memory.ts";
import { openQmd, qmdLocation, type Searcher, searchMemoryNotes, storeSearcher } from "./qmd.ts";
import { afterMemoryWrite, viaService } from "./service-client.ts";
import { VaultModel, walkVault } from "./vault.ts";
import { realTarget, WriteRefused } from "./vault-file.ts";
import { stampNote } from "./write.ts";

/** The one vault and qmd collection this server serves. */
const VAULT = "llmos";
const COLLECTION = "llmos";

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects.
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects.
const CONTROL_EXCEPT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** One line of at most `max` characters, without control characters. */
function line(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !ANY_CONTROL.test(value), "must be one line without control characters");
}

/** Prose of at most `max` characters: lines and tabs, no other control characters. */
function prose(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_EXCEPT_LINES.test(value), "must not contain control characters");
}

const MEMORY_PROJECT =
  "Vault project folder under projects/ whose memory to use; the session-start context " +
  "names it. Default: the project of the session's folder, when the client names one.";
const MEMORY_NOTE =
  "In this server: pass project. Without it, the scope comes from the session's folder " +
  "(the client's first root, else the folder the agent started the server in), and the " +
  "call fails when the client names none.";

/** The registry command a tool runs. */
function command(name: string): Command {
  const found = COMMANDS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no llmos command named '${name}'`);
  return found;
}

/** The help of a command's argument or option. */
function help(source: Command, name: string): string {
  const argument = source.arguments.find((entry) => entry.name === name);
  const text = argument?.help ?? source.options[name]?.help;
  if (text === undefined) throw new Error(`'${source.name}' has no parameter '${name}'`);
  return text;
}

/** What a tool call needs: the handler context, the warm qmd store, and the client's roots. */
interface CallState {
  context: Context;
  store(): Promise<QMDStore>;
  /**
   * The searcher of a qmd tool: the llmOS service when it runs (started when
   * it does not), else this server's own warm store.
   */
  searcher(): Searcher;
  /** The client's root folders, first is the session's; empty when it offers none. */
  roots(): Promise<string[]>;
}

interface Tool {
  name: string;
  command: Command;
  schema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Extra description for behavior that differs from the command line. */
  note?: string;
  call(args: Record<string, unknown>, state: CallState): Promise<Outcome> | Outcome;
}

/** The llmOS root of this call. */
function rootOf(state: CallState): string {
  return state.context.root(VAULT);
}

/**
 * The vault-relative path of note `name`, refused unless its real path is
 * inside the real vault root: a symbolic link out of the vault is not a
 * note this server reads or writes.
 */
function insideNote(state: CallState, root: string, name: string): string {
  const note = state.context.model(root).resolveNote(name);
  try {
    realTarget(root, note.path);
  } catch (error) {
    if (error instanceof WriteRefused) {
      throw new WriteRefused(`'${name}' is not a note inside the vault`);
    }
    throw error;
  }
  return note.path;
}

/** Run a registry handler with `values` and the vault fixed to llmOS. */
function run(source: Command, values: Values, state: CallState): Promise<Outcome> | Outcome {
  return source.run({ ...values, vault: VAULT }, state.context);
}

/** Stamp each changed note with today's date. */
function stamp(state: CallState, root: string, paths: string[]): void {
  for (const path of paths) stampNote(root, path, state.context.today());
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/**
 * The memory scope of a tool call. The named vault project wins. Without
 * one, the session's folder picks it: the client's first root (Claude Code
 * sends the project), then `CLAUDE_PROJECT_DIR`, then the folder the
 * launcher started in (`LLMOS_SESSION_CWD`). The server's own folder is
 * its install, never the session's, so with no signal the call fails
 * rather than guess. A tool takes a project name, never a path.
 */
async function memoryScopeOf(
  state: CallState,
  root: string,
  project: unknown,
): Promise<MemoryScope> {
  if (typeof project === "string") return projectScope(root, project);
  const env = state.context.env;
  const folder =
    (await state.roots())[0] ?? env.CLAUDE_PROJECT_DIR ?? env.LLMOS_SESSION_CWD ?? null;
  if (!folder) {
    throw new MemoryRefused(
      "this client names no session folder; pass project (the session-start context names it)",
    );
  }
  return memoryScope(root, folder);
}

function readTool(name: string, source: Command, extra: Partial<Tool> = {}): Tool {
  const note = line(1024).describe(help(source, "note"));
  return {
    name,
    command: source,
    schema: z.strictObject({ note }),
    annotations: READ,
    call(args, state) {
      const root = rootOf(state);
      return run(source, { note: insideNote(state, root, args.note as string) }, state);
    },
    ...extra,
  };
}

function tools(): Tool[] {
  const readCommand = command("read");
  const listCommand = command("list");
  const subgraph = command("subgraph");
  const searchCommand = command("search");
  const checkCommand = command("check");
  const health = command("health");
  const thought = command("daily append-thought");
  const fileInbox = command("file-inbox");
  const setProperty = command("set-property");
  const memorySave = command("memory save");
  const memorySearchCommand = command("memory search");
  const memoryForgetCommand = command("memory forget");
  return [
    readTool("read", readCommand, {
      schema: z.strictObject({
        note: line(1024).describe(help(readCommand, "note")),
        section: line(500).optional().describe(help(readCommand, "section")),
        properties_only: z.boolean().optional().describe(help(readCommand, "properties-only")),
      }),
      call(args, state) {
        const root = rootOf(state);
        const note = insideNote(state, root, args.note as string);
        const values: Values = { note, "properties-only": args.properties_only === true };
        if (args.section !== undefined) values.section = args.section as string;
        return run(readCommand, values, state);
      },
    }),
    {
      name: "list",
      command: listCommand,
      schema: z.strictObject({
        folder: line(1024).describe(help(listCommand, "folder")),
        properties_only: z
          .boolean()
          .optional()
          .describe(`${help(listCommand, "properties-only")} Default: true.`),
      }),
      annotations: READ,
      note:
        "In this server: folder is required and the bodies are left out unless " +
        "properties_only is false, so one call reads the properties of a whole folder.",
      async call(args, state) {
        const root = rootOf(state);
        const outcome = await run(
          listCommand,
          { folder: args.folder as string, "properties-only": args.properties_only !== false },
          state,
        );
        // A symbolic link out of the vault is not a note this server reads.
        const notes = (outcome.json as { path: string }[]).filter((note) => {
          try {
            realTarget(root, relative(root, note.path));
            return true;
          } catch (error) {
            if (error instanceof WriteRefused) return false;
            throw error;
          }
        });
        return { json: notes };
      },
    },
    readTool("neighbors", command("neighbors")),
    readTool("subgraph", subgraph, {
      schema: z.strictObject({
        note: line(1024).describe(help(subgraph, "note")),
        depth: z
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe(`${help(subgraph, "depth")} Default: 1.`),
      }),
      call(args, state) {
        const root = rootOf(state);
        const note = insideNote(state, root, args.note as string);
        return run(subgraph, { note, depth: (args.depth as number | undefined) ?? 1 }, state);
      },
    }),
    readTool("check", checkCommand, {
      schema: z.strictObject({ note: line(1024).optional().describe(help(checkCommand, "note")) }),
      call(args, state) {
        const name = args.note as string | undefined;
        const note = name === undefined ? {} : { note: insideNote(state, rootOf(state), name) };
        return run(checkCommand, note, state);
      },
    }),
    {
      name: "health",
      command: health,
      schema: z.strictObject({}),
      annotations: READ,
      call: (_args, state) =>
        run(health, { json: true, "qmd-collection": COLLECTION, "stale-after-days": 14 }, state),
    },
    {
      name: "search",
      command: searchCommand,
      schema: z.strictObject({
        query: line(1000).describe(help(searchCommand, "query")),
        semantic: z.boolean().optional().describe(help(searchCommand, "semantic")),
        hybrid: z.boolean().optional().describe(help(searchCommand, "hybrid")),
        limit: z
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(`${help(searchCommand, "limit")} Default: 10.`),
      }),
      annotations: READ,
      note:
        "In this server: semantic: true selects vector search and hybrid: true the full " +
        "pipeline (it wins when both are set). The search runs on the llmOS collection. The " +
        "llmOS service keeps the models loaded for every session on this host, and the first " +
        "search starts it when it is down; that search loads the models in this server, " +
        "which qmd unloads after 5 minutes idle.",
      // The handler opens and closes its own store, which would load the
      // models again on every call that uses them; the service, or the
      // warm store when the service is down, keeps them.
      async call(args, state) {
        const hits = await state.searcher()(args.query as string, {
          collection: COLLECTION,
          limit: (args.limit as number | undefined) ?? 10,
          mode: searchMode(args as Values),
        });
        return { json: hits };
      },
    },
    {
      name: "memory_save",
      command: memorySave,
      schema: z.strictObject({
        name: line(80).describe(help(memorySave, "name")),
        description: line(300).describe(help(memorySave, "description")),
        body: prose(20_000).describe(help(memorySave, "body")),
        type: z.enum(MEMORY_TYPES).describe(help(memorySave, "type")),
        title: line(120).optional().describe(help(memorySave, "title")),
        project: line(100).optional().describe(MEMORY_PROJECT),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      note: MEMORY_NOTE,
      async call(args, state) {
        const root = rootOf(state);
        const input: MemoryInput = {
          name: args.name as string,
          description: args.description as string,
          body: args.body as string,
          type: args.type as MemoryInput["type"],
        };
        if (args.title !== undefined) input.title = args.title as string;
        const scope = await memoryScopeOf(state, root, args.project);
        const saved = saveMemory(root, scope, input, new Date(), state.context.env);
        await afterMemoryWrite(state.context.env);
        return { json: saved };
      },
    },
    {
      name: "memory_search",
      command: memorySearchCommand,
      schema: z.strictObject({
        query: line(1000).describe(help(memorySearchCommand, "query")),
        keyword: z.boolean().optional().describe(help(memorySearchCommand, "keyword")),
        limit: z
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(`${help(memorySearchCommand, "limit")} Default: 5.`),
        project: line(100).optional().describe(MEMORY_PROJECT),
      }),
      annotations: READ,
      note: `${MEMORY_NOTE} The models stay loaded between calls (the llmOS service), as in search.`,
      async call(args, state) {
        const root = rootOf(state);
        const hits = await searchMemoryNotes(
          state.searcher(),
          await memoryScopeOf(state, root, args.project),
          args.query as string,
          {
            limit: (args.limit as number | undefined) ?? 5,
            mode: args.keyword === true ? "keyword" : "semantic",
          },
        );
        return { json: hits };
      },
    },
    {
      name: "memory_forget",
      command: memoryForgetCommand,
      schema: z.strictObject({
        name: line(80).describe(help(memoryForgetCommand, "name")),
        project: line(100).optional().describe(MEMORY_PROJECT),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      note: MEMORY_NOTE,
      async call(args, state) {
        const root = rootOf(state);
        const scope = await memoryScopeOf(state, root, args.project);
        const forgotten = forgetMemory(root, scope, args.name as string, state.context.env);
        await afterMemoryWrite(state.context.env);
        return { json: forgotten };
      },
    },
    {
      name: "daily_append_thought",
      command: thought,
      schema: z.strictObject({ text: prose(20_000).describe(help(thought, "text")) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async call(args, state) {
        const root = rootOf(state);
        const outcome = await run(thought, { text: args.text as string }, state);
        stamp(state, root, [`${DAILY_DIR}/${state.context.today()}.md`]);
        return outcome;
      },
    },
    {
      name: "file_inbox",
      command: fileInbox,
      schema: z.strictObject({
        note: line(1024).describe(help(fileInbox, "note")),
        destination: line(1024).describe(help(fileInbox, "destination")),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async call(args, state) {
        const root = rootOf(state);
        const destination = args.destination as string;
        const target = destination.endsWith(".md") ? destination : `${destination}.md`;
        const note = args.note as string;
        // A note already filed at the destination is no longer found by its
        // name, and the handler reports that case itself. Any note it does
        // find must be inside the vault.
        try {
          insideNote(state, root, note);
        } catch (error) {
          if (error instanceof WriteRefused) throw error;
        }
        const outcome = await run(fileInbox, { note, destination }, state);
        stamp(state, root, [target]);
        return outcome;
      },
    },
    {
      name: "set_property",
      command: setProperty,
      schema: z.strictObject({
        note: line(1024).describe(help(setProperty, "note")),
        key: line(200).describe(help(setProperty, "key")),
        value: z.string().max(2000).describe(help(setProperty, "value")),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      async call(args, state) {
        const root = rootOf(state);
        const note = insideNote(state, root, args.note as string);
        const outcome = await run(
          setProperty,
          { note, key: args.key as string, value: args.value as string },
          state,
        );
        stamp(state, root, [note]);
        return outcome;
      },
    },
  ];
}

/** A tool's description: the command's summary and help, plus what differs here. */
function describe(tool: Tool): string {
  const parts = [tool.command.summary, tool.command.description];
  if (tool.note) parts.push(tool.note);
  return parts.join("\n\n");
}

export const INSTRUCTIONS = `Tools for the shared llmOS Obsidian vault (the vault in $LLMOS_ROOT or ~/.config/llmos/config.json).
Prefer them to the llmos command line: arguments need no shell quoting, and the vault model and search models stay loaded.
Read: read (one note; section for one heading, properties_only for the frontmatter), list (the properties of every note under a folder), neighbors and subgraph (links), check (unlinked references and Markdown that renders wrongly), health (vault hygiene), search (qmd keyword search by default; semantic: true for vector search, about 1 s; hybrid: true for query expansion and reranking, 13 to 22 s, only when the others miss).
Write: daily_append_thought (a paragraph under ## Thoughts in today's daily note), file_inbox (file an inbox note; needs the running Obsidian app), set_property (one frontmatter property). Write tools stamp updated themselves.
Memory: memory_save (one shared project memory: a topic note and its MEMORY.md index line), memory_search (the memories that match a query; semantic by default), memory_forget (delete one memory). Save a fact any agent can use; one session's progress is not a memory.
Before creating or materially editing a note, follow the vault's AGENTS.md and authoring.md. Paths are vault-relative; nothing outside the vault is read or written.`;

/**
 * A fingerprint of every file the model reads (the notes and the other files
 * that links can target), by identity and change time. Cheap next to reading the notes.
 */
export function vaultSignature(root: string): string {
  const parts: string[] = [];
  for (const path of walkVault(root)) {
    try {
      const stat = statSync(`${root}/${path}`);
      parts.push(`${path}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`);
    } catch {
      parts.push(`${path}\0missing`);
    }
  }
  return parts.join("\n");
}

/** One vault model per root, loaded again when a note file changes. */
class WarmVault {
  private cached: { root: string; signature: string; model: VaultModel } | null = null;
  model(root: string): VaultModel {
    // The fingerprint is taken before the load: a file that changes during
    // the load makes the next call load again, never keep a stale model.
    const signature = vaultSignature(root);
    const cached = this.cached;
    if (cached && cached.root === root && cached.signature === signature) return cached.model;
    const model = VaultModel.load(root);
    this.cached = { root, signature, model };
    return model;
  }
}

function message(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `invalid arguments: ${error.issues
      .map((issue) => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`)
      .join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function result(outcome: Outcome): { content: { type: "text"; text: string }[] } {
  const text = outcome.json !== undefined ? JSON.stringify(outcome.json) : (outcome.text ?? "");
  return { content: [{ type: "text", text }] };
}

/** The shared state of one server process. */
export class ServerState {
  readonly vault = new WarmVault();
  private store: Promise<QMDStore> | null = null;

  constructor(readonly context: Context) {}

  /** The handler context, with the warm vault model. */
  handlerContext(): Context {
    return { ...this.context, model: (root) => this.vault.model(root) };
  }

  /** The qmd store, opened once; never creates an index. */
  openStore(): Promise<QMDStore> {
    if (this.store === null) {
      const location = qmdLocation(this.context.env);
      if (!existsSync(location.dbPath)) {
        return Promise.reject(
          new Error(`no qmd index at ${location.dbPath}; add the collection with qmd first`),
        );
      }
      this.store = openQmd(location, false);
      this.store.catch(() => {
        this.store = null;
      });
    }
    return this.store;
  }

  async close(): Promise<void> {
    const store = this.store;
    this.store = null;
    if (store) await (await store).close();
  }
}

/** Run one tool call; any failure becomes a tool error result, never a protocol error. */
async function invoke(
  tool: Tool,
  args: unknown,
  state: CallState,
): Promise<{ isError?: boolean; content: { type: "text"; text: string }[] }> {
  try {
    // Checked here again, so the handler never relies on the SDK's check.
    const checked = tool.schema.parse(args) as Record<string, unknown>;
    return result(await tool.call(checked, state));
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: message(error) }] };
  }
}

/** The client's root folders, asked fresh each call (roots can change); empty when it offers none. */
async function clientRoots(server: McpServer): Promise<string[]> {
  if (!server.server.getClientCapabilities()?.roots) return [];
  try {
    const { roots } = await server.server.listRoots(undefined, { timeout: 2_000 });
    return roots.flatMap((entry) =>
      entry.uri.startsWith("file://") ? [fileURLToPath(entry.uri)] : [],
    );
  } catch {
    return [];
  }
}

/** Build the MCP server and its tools over `state`. */
export function createServer(state: ServerState): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: "1" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const callState: CallState = {
    context: state.handlerContext(),
    store: () => state.openStore(),
    searcher: () =>
      viaService(
        state.context.env,
        async (query, options) => storeSearcher(await state.openStore())(query, options),
        { start: true },
      ),
    roots: () => clientRoots(server),
  };
  for (const tool of tools()) {
    server.registerTool(
      tool.name,
      { description: describe(tool), inputSchema: tool.schema, annotations: tool.annotations },
      (args: unknown) => invoke(tool, args, callState),
    );
  }
  return server;
}

/**
 * Serve over stdio until stdin closes (the client is gone), then close the
 * qmd store. The caller passes the streams: the process's stdin and stdout, or
 * test streams.
 */
export async function serve(
  context: Context,
  streams: { stdin: Readable; stdout: Writable },
): Promise<void> {
  const state = new ServerState(context);
  const transport = new StdioServerTransport(streams.stdin, streams.stdout);
  const handle = serveStdio(() => createServer(state), {
    transport,
    onerror: (error) => process.stderr.write(`llmos mcp: ${error.message}\n`),
  });
  await new Promise<void>((resolve) => {
    if (streams.stdin.readableEnded || streams.stdin.destroyed) resolve();
    streams.stdin.once("end", () => resolve());
    streams.stdin.once("close", () => resolve());
  });
  await handle.close();
  await state.close();
}
