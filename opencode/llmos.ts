/**
 * The llmOS hooks for OpenCode 2, as a server plugin. It runs the same bundles
 * as Claude Code (`dist/pre-tool-use.js`, `dist/hooks.js` of the installed
 * plugin) and sends them the payload they read for Claude Code. Install it as
 * a real file: OpenCode skips a plugin whose file is a symbolic link.
 *
 *   cp ~/.local/share/llmos/current/opencode/llmos.ts ~/.config/opencode/plugins/llmos.ts
 *
 * Every adapter failure lets the tool call run; only a guard denial fails it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = process.env.HOME || homedir();
const PLUGIN_ROOT =
  process.env.LLMOS_PLUGIN_ROOT || join(HOME, ".local", "share", "llmos", "current");
// The heartbeat names the agent from this path (`hookAgent` in `cli/src/hooks/heartbeat.ts`).
const MARKER = join(
  process.env.XDG_CONFIG_HOME || join(HOME, ".config"),
  "opencode",
  "plugins",
  "llmos",
);
const BUN_FALLBACKS = [
  join(HOME, ".local", "share", "mise", "shims", "bun"),
  join(HOME, ".bun", "bin", "bun"),
];
const PRE_TOOL_USE_MS = 10_000;
const STOP_MS = 30_000;

/** OpenCode tool names as the Claude Code tools the hooks know. */
const CLAUDE_TOOLS: Record<string, string> = {
  shell: "Bash",
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  write: "Write",
  edit: "Edit",
};

interface ToolEvent {
  tool: string;
  id: string;
  sessionID: string;
  input?: Record<string, unknown>;
  status?: string;
  result?: { content?: unknown[] };
}
interface Context {
  location: { directory: string };
  session: {
    hook(
      name: "context",
      fn: (e: { sessionID: string; system: unknown[] }) => Promise<void>,
    ): unknown;
    get(input: { sessionID: string }): Promise<{ directory?: string }>;
  };
  tool: { hook(name: string, fn: (e: ToolEvent) => Promise<void>): unknown };
  event: {
    subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<{
      data: { sessionID: string };
    }>;
  };
}
interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function bun(): string {
  const found = (process.env.PATH ?? "").split(":").map((dir) => join(dir, "bun"));
  return [...found, ...BUN_FALLBACKS].find((path) => existsSync(path)) ?? "bun";
}

function start(bundle: string, event: string, timeout: number, detached = false) {
  const bundlePath = join(PLUGIN_ROOT, "dist", bundle);
  return spawn(bun(), ["--no-env-file", "--config=/dev/null", bundlePath, event], {
    env: { ...process.env, PLUGIN_ROOT: MARKER },
    stdio: ["pipe", detached ? "ignore" : "pipe", detached ? "ignore" : "pipe"],
    detached,
    timeout,
  });
}

/** Run one hook event; null when the hook cannot run (no bundle, no `bun`, a timeout). */
function run(bundle: string, event: string, payload: object, timeout: number): Promise<Ran | null> {
  return new Promise((resolve) => {
    try {
      const child = start(bundle, event, timeout);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === null ? null : { code, stdout, stderr }));
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      resolve(null);
    }
  });
}

/** The context a hook wrote: plain stdout (`session-start`) or `additionalContext` JSON. */
function contextOf(ran: Ran | null): string | null {
  const text = ran?.code === 0 ? ran.stdout.trim() : "";
  if (!text) return null;
  try {
    const context = JSON.parse(text)?.hookSpecificOutput?.additionalContext;
    return typeof context === "string" && context ? context : null;
  } catch {
    return text;
  }
}

function setup(ctx: Context) {
  const folders = new Map<string, Promise<string>>();
  const sessionContexts = new Map<string, Promise<string | null>>();
  const toolContexts = new Map<string, string>();

  const folderOf = (sessionID: string): Promise<string> => {
    let folder = folders.get(sessionID);
    if (!folder) {
      folder = ctx.session
        .get({ sessionID })
        .then((session) => session.directory || ctx.location.directory)
        .catch(() => ctx.location.directory);
      folders.set(sessionID, folder);
    }
    return folder;
  };

  const payload = async (e: {
    sessionID: string;
    input?: Record<string, unknown>;
    tool?: string;
  }) => {
    const input = e.input ?? {};
    const folder = await folderOf(e.sessionID);
    const workdir = typeof input.workdir === "string" && input.workdir ? input.workdir : null;
    return {
      session_id: e.sessionID,
      cwd: workdir ? resolve(folder, workdir) : folder,
      tool_name: e.tool ? CLAUDE_TOOLS[e.tool] : undefined,
      tool_input: input,
    };
  };

  ctx.session.hook("context", async (e) => {
    let started = sessionContexts.get(e.sessionID);
    if (!started) {
      started = payload(e)
        .then((body) => run("hooks.js", "session-start", body, 10_000))
        .then(contextOf);
      sessionContexts.set(e.sessionID, started);
    }
    const text = await started;
    if (text) e.system.push({ type: "text", text });
  });

  ctx.tool.hook("execute.before", async (e) => {
    if (!CLAUDE_TOOLS[e.tool]) return;
    const ran = await run("pre-tool-use.js", "pre-tool-use", await payload(e), PRE_TOOL_USE_MS);
    if (ran?.code === 2) throw new Error(ran.stderr.trim() || "Blocked by the llmOS vault guard.");
    const context = contextOf(ran);
    if (context) toolContexts.set(e.id, context);
  });

  ctx.tool.hook("execute.after", async (e) => {
    const notes = [toolContexts.get(e.id)];
    toolContexts.delete(e.id);
    if (e.status !== "completed" || !CLAUDE_TOOLS[e.tool]) return;
    if (e.tool === "write" || e.tool === "edit") {
      const ran = await run("hooks.js", "post-tool-use", await payload(e), PRE_TOOL_USE_MS);
      notes.push(contextOf(ran) ?? undefined);
    }
    const text = notes.filter(Boolean).join("\n\n");
    if (text) {
      e.result = {
        ...e.result,
        content: [...(e.result?.content ?? []), { type: "text", text: `[llmOS vault]\n${text}` }],
      };
    }
  });

  const controller = new AbortController();
  void (async () => {
    const turns = ctx.event.subscribe({
      types: ["session.execution.succeeded"],
      signal: controller.signal,
    });
    for await (const event of turns) {
      const body = await payload({ sessionID: event.data.sessionID });
      try {
        const child = start("hooks.js", "stop", STOP_MS, true);
        child.on("error", () => {});
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify(body));
        child.unref();
      } catch {}
    }
  })().catch(() => {});
  return () => controller.abort();
}

export default { id: "llmos", setup };
