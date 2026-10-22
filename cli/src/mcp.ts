/**
 * `llmos-vault mcp`: the llmOS vault tools as an MCP server on stdio, built
 * on the official TypeScript MCP SDK. The plugin's `.mcp.json` starts it
 * through the launcher `dist/mcp.js` (`src/mcp-launcher.ts`).
 *
 * Each tool calls a handler of the CLI command registry (`commands.ts`), and
 * its description and parameter help come from that command, so help text
 * has one source. The server keeps one vault model, loaded again only when
 * a note's file changes on disk (other sessions and tools edit the vault
 * too), and one qmd store, so the models of a semantic search stay loaded
 * between calls.
 *
 * Tool arguments come from a model and may be hostile. Each handler checks
 * its arguments against the tool's schema again, every note argument must
 * resolve to a note whose real path (symbolic links resolved) is inside the
 * real vault root, and every write goes through the containment checks of
 * `write.ts`. Only the llmOS vault and its `llmos` qmd collection are
 * served. There is no shell, move, create, or arbitrary-file tool.
 *
 * The write tools stamp `updated` and `authors` on each note they change,
 * because the PostToolUse stamp hook reads only `Write`-style tool inputs.
 */

import { existsSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { QMDStore } from "@tobilu/qmd";
import * as z from "zod";
import type { Command, Context, Outcome, Values } from "./cli.ts";
import { COMMANDS, searchMode } from "./commands.ts";
import { DAILY_DIR } from "./daily.ts";
import { SERVER_NAME } from "./mcp-names.ts";
import { detectProvider } from "./provider.ts";
import { openQmd, qmdLocation, search } from "./qmd.ts";
import { VaultModel, walkVault } from "./vault.ts";
import { realTarget, stampNote, WriteRefused } from "./write.ts";

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

/** The registry command a tool runs. */
function command(name: string): Command {
  const found = COMMANDS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no llmos-vault command named '${name}'`);
  return found;
}

/** The help of a command's argument or option. */
function help(source: Command, name: string): string {
  const argument = source.arguments.find((entry) => entry.name === name);
  const text = argument?.help ?? source.options[name]?.help;
  if (text === undefined) throw new Error(`'${source.name}' has no parameter '${name}'`);
  return text;
}

/** What a tool call needs: the handler context, the client's provider name, and the warm qmd store. */
interface CallState {
  context: Context;
  provider(): string | null;
  store(): Promise<QMDStore>;
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

/** Stamp each changed note with today's date and the client's provider. */
function stamp(state: CallState, root: string, paths: string[]): void {
  for (const path of paths) stampNote(root, path, state.context.today(), state.provider());
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

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
  const health = command("health");
  const thought = command("daily append-thought");
  const fileInbox = command("file-inbox");
  const setProperty = command("set-property");
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
    readTool("check", command("check")),
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
        "pipeline (it wins when both are set). The search runs on the llmOS collection, and " +
        "the models stay loaded between calls; qmd unloads them after 5 minutes idle.",
      // The handler opens and closes its own store, which would load the
      // models again on every call that uses them; the warm store keeps them.
      async call(args, state) {
        const hits = await search(await state.store(), args.query as string, {
          collection: COLLECTION,
          limit: (args.limit as number | undefined) ?? 10,
          mode: searchMode(args as Values),
        });
        return { json: hits };
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
        stamp(state, root, [target, `${DAILY_DIR}/${state.context.today()}.md`]);
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
Prefer them to the llmos-vault command line: arguments need no shell quoting, and the vault model and search models stay loaded.
Read: read (one note; section for one heading, properties_only for the frontmatter), list (the properties of every note under a folder), neighbors and subgraph (links), check (unlinked references and Markdown that renders wrongly), health (vault hygiene), search (qmd keyword search by default; semantic: true for vector search, about 1 s; hybrid: true for query expansion and reranking, 13 to 22 s, only when the others miss).
Write: daily_append_thought (a paragraph under ## Thoughts in today's daily note), file_inbox (file an inbox note; needs the running Obsidian app), set_property (one frontmatter property). Write tools stamp updated and authors themselves.
Before creating or materially editing a note, follow the vault's AGENTS.md and agents/references/authoring.md. Paths are vault-relative; nothing outside the vault is read or written.`;

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
export class WarmVault {
  private cached: { root: string; signature: string; model: VaultModel } | null = null;
  /** How many times a model was read from disk (for tests). */
  loads = 0;

  model(root: string): VaultModel {
    // The fingerprint is taken before the load: a file that changes during
    // the load makes the next call load again, never keep a stale model.
    const signature = vaultSignature(root);
    const cached = this.cached;
    if (cached && cached.root === root && cached.signature === signature) return cached.model;
    const model = VaultModel.load(root);
    this.loads++;
    this.cached = { root, signature, model };
    return model;
  }
}

/**
 * The provider name to stamp into `authors`: from the client's MCP name
 * (Codex sends "codex-mcp-client"), else from the environment markers
 * (Claude Code sets `CLAUDECODE` for the MCP servers it starts).
 */
export function providerFor(clientName: string | undefined, env: Context["env"]): string | null {
  const name = (clientName ?? "").toLowerCase();
  for (const provider of ["codex", "claude", "gemini"]) {
    if (name.includes(provider)) return provider;
  }
  return detectProvider(env);
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

/** Build the MCP server and its tools over `state`. */
export function createServer(state: ServerState): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: "1" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const callState: CallState = {
    context: state.handlerContext(),
    // Deprecated in the SDK, but it still answers for both protocol eras.
    provider: () => providerFor(server.server.getClientVersion()?.name, state.context.env),
    store: () => state.openStore(),
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
 * qmd store. `streams` replaces the process's stdin and stdout in tests.
 */
export async function serve(
  context: Context,
  streams: { stdin: Readable; stdout: Writable } = { stdin: process.stdin, stdout: process.stdout },
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
