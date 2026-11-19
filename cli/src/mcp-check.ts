/**
 * `llmos doctor`'s MCP check: start the server the plugin launcher would
 * start on this host, and list its tools over the protocol. The launcher
 * falls back to a setup-guidance tool instead of failing, and a server that
 * fails at start shows only in the harness's MCP panel, so neither would
 * otherwise reach the user. Starting the server reads and writes nothing in
 * the vault.
 */

import { dirname } from "node:path";
import { installedServer, SAFE_BUN_FLAGS } from "./mcp-launcher.ts";
import { READ_TOOLS, WRITE_TOOLS } from "./mcp-names.ts";

type Env = Record<string, string | undefined>;

/** The tool names a server at `entry` lists, or why it could not list them. */
async function listTools(entry: string, env: Env, timeoutMs: number): Promise<string[]> {
  const child = Bun.spawn([process.execPath, ...SAFE_BUN_FLAGS, entry, "mcp"], {
    cwd: dirname(dirname(entry)),
    env: { ...env, GGML_METAL_NO_RESIDENCY: "1" } as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (message: object): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "llmos doctor", version: "1" },
    },
  });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list", params: {} });
  const reply = (async (): Promise<string[]> => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at)) as {
          id?: number;
          result?: { tools?: { name: string }[] };
        };
        buffer = buffer.slice(at + 1);
        if (message.id === 2) return (message.result?.tools ?? []).map((tool) => tool.name);
      }
    }
    const stderr = (await new Response(child.stderr).text()).trim();
    throw new Error(`the server exited before listing its tools${stderr ? `: ${stderr}` : ""}`);
  })();
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no tool list within ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([reply, timeout]);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}

/** The check's result: a PASS detail, or a FAIL detail. */
export async function mcpCheck(
  env: Env,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const found = installedServer(env);
  if ("reason" in found) {
    return { ok: false, detail: `${found.reason}; sessions get only the setup tool` };
  }
  try {
    const tools = await listTools(found.entry, env, timeoutMs);
    const expected = [...READ_TOOLS, ...WRITE_TOOLS];
    const missing = expected.filter((tool) => !tools.includes(tool));
    if (missing.length > 0) {
      return { ok: false, detail: `${found.entry} mcp lacks ${missing.join(", ")}` };
    }
    return { ok: true, detail: `${found.entry} mcp lists ${tools.length} tools` };
  } catch (error) {
    return { ok: false, detail: `${found.entry} mcp: ${(error as Error).message}` };
  }
}
