/**
 * The plugin's MCP launcher, bundled into the committed `dist/mcp.js`; the
 * plugin's `.mcp.json` runs it in every Claude Code and Codex session.
 *
 * It runs the installed CLI's server (`llmos mcp`) through the
 * `~/.local/bin/llmos` link that `cli/scripts/install.ts` makes. That server
 * runs as a child with `GGML_METAL_NO_RESIDENCY=1`, which must be set before
 * the qmd models' native library loads (see `bin/llmos.ts`).
 *
 * Nothing here depends on the session's working directory, which is the
 * project the session opened: the child runs in the install folder, with
 * Bun's `.env` and `bunfig.toml` loading off (a project's `bunfig.toml`
 * preload would run its code, and its `.env` could replace `LLMOS_ROOT`) and
 * auto-install off (no package is ever fetched). The plugin's `.mcp.json`
 * starts this launcher with the same flags.
 *
 * Without such an install it serves one tool, `setup`, that says to run
 * setup-llmos, so a session shows that advice instead of a failed server.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SERVER_NAME } from "./mcp-names.ts";

type Env = Record<string, string | undefined>;

/** Bun flags that keep a working directory's `.env`, `bunfig.toml`, and package fetches out. */
export const SAFE_BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"];

/** The installed CLI entry point (`<install>/cli/bin/llmos.ts`), or why there is none. */
export function installedServer(env: Env): { entry: string } | { reason: string } {
  const link = join(env.HOME || homedir(), ".local", "bin", "llmos");
  let entry: string;
  try {
    entry = realpathSync(link);
  } catch {
    return { reason: `the llmOS CLI is not installed (no ${link})` };
  }
  return { entry };
}

export const SETUP_TEXT =
  "The llmOS vault tools are unavailable in this session: REASON. Run the setup-llmos " +
  "skill (it installs the CLI with cli/scripts/install.ts), then start a new session. Until " +
  "then, read and edit vault notes with the ordinary file tools.";

/** Serve the single `setup` tool until stdin closes. */
async function serveSetup(reason: string): Promise<void> {
  const text = SETUP_TEXT.replace("REASON", reason);
  // Loaded only here, so the usual path never evaluates the SDK.
  const { McpServer } = await import("@modelcontextprotocol/server");
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  const handle = serveStdio(() => {
    const server = new McpServer(
      { name: SERVER_NAME, version: "1" },
      { capabilities: { tools: {} }, instructions: text },
    );
    server.registerTool(
      "setup",
      {
        description: `Explains how to enable the llmOS vault tools: ${text}`,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      () => ({ content: [{ type: "text", text }] }),
    );
    return server;
  });
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await handle.close();
}

/** Run the installed server as a child that shares this process's stdio. */
async function runServer(entry: string): Promise<number> {
  const argv = [process.execPath, ...SAFE_BUN_FLAGS, entry, "mcp"];
  const child = Bun.spawn(argv, {
    cwd: dirname(dirname(entry)),
    env: { ...process.env, GGML_METAL_NO_RESIDENCY: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  return await child.exited;
}

if (import.meta.main) {
  const found = installedServer(process.env);
  if ("entry" in found) process.exit(await runServer(found.entry));
  await serveSetup(found.reason);
  process.exit(0);
}
