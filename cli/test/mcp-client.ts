/**
 * A minimal MCP client for tests: newline-delimited JSON-RPC over a pair of
 * streams, speaking the 2025-era stdio protocol that Claude Code and Codex
 * use (an `initialize` request first).
 */

import { PassThrough } from "node:stream";
import type { Context } from "../src/cli.ts";
import { serve } from "../src/mcp.ts";

type Message = {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export interface ToolResult {
  isError: boolean;
  text: string;
}

export class McpClient {
  private buffer = "";
  private next = 0;
  private readonly waiting = new Map<number, (message: Message) => void>();

  constructor(
    private readonly write: (line: string) => void,
    chunks: AsyncIterable<Uint8Array | string>,
    /** Root folders to answer `roots/list` with; `null` offers no roots capability. */
    private readonly roots: string[] | null = null,
  ) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of chunks) {
        this.buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
          const message = JSON.parse(this.buffer.slice(0, at)) as Message;
          this.buffer = this.buffer.slice(at + 1);
          if (message.method === "roots/list" && message.id !== undefined) {
            const roots = (this.roots ?? []).map((path) => ({ uri: Bun.pathToFileURL(path).href }));
            this.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { roots } })}\n`,
            );
          } else if (message.id !== undefined) this.waiting.get(message.id)?.(message);
        }
      }
    })();
  }

  request(method: string, params: unknown): Promise<Message> {
    const id = ++this.next;
    const reply = new Promise<Message>((resolve) => this.waiting.set(id, resolve));
    this.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return reply;
  }

  /** `initialize` as `clientName`, then the `initialized` notification. */
  async initialize(clientName: string): Promise<Record<string, unknown>> {
    const reply = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: this.roots === null ? {} : { roots: { listChanged: false } },
      clientInfo: { name: clientName, version: "0" },
    });
    this.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return reply.result as Record<string, unknown>;
  }

  async tools(): Promise<Record<string, unknown>[]> {
    const reply = await this.request("tools/list", {});
    return (reply.result as { tools: Record<string, unknown>[] }).tools;
  }

  /** A tool call; a protocol error counts as a tool error. */
  async call(name: string, args: unknown): Promise<ToolResult> {
    const reply = await this.request("tools/call", { name, arguments: args });
    if (reply.error) return { isError: true, text: reply.error.message };
    const result = reply.result as { isError?: boolean; content: { text: string }[] };
    return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
  }
}

/** An in-process server over `context`, and a client connected to it. */
export async function connect(
  context: Context,
  clientName = "codex-mcp-client",
  roots: string[] | null = null,
): Promise<{ client: McpClient; close: () => Promise<void> }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = serve(context, { stdin, stdout });
  const client = new McpClient((line) => stdin.write(line), stdout, roots);
  await client.initialize(clientName);
  return {
    client,
    close: async () => {
      stdin.end();
      await done;
    },
  };
}
