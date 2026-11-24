/**
 * The client side of the llmOS service (`service.ts`): ask it, start it, and
 * fall back when it is down. It loads no qmd code until a store is needed.
 *
 * A search goes to the service when one runs. `llmos mcp` starts the service
 * when it finds none (`start: true`) and answers that call itself; the search
 * verbs only use a service that already runs. A service that is down, slow
 * to answer, or fails always means "run it in this process", so a client
 * never does worse than it did without the service.
 */

import { existsSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { stateDir } from "./heartbeat.ts";
import {
  MEMORY_COLLECTION,
  openQmd,
  QmdCollectionMissing,
  qmdLocation,
  type Searcher,
} from "./qmd.ts";
import { startDetached } from "./run.ts";
import type { ServiceStatus } from "./service.ts";

export type Env = Record<string, string | undefined>;

export const SERVICE_COLLECTIONS = ["llmos", MEMORY_COLLECTION] as const;
/** A Unix socket path must fit `sockaddr_un` (104 bytes on macOS). */
export const MAX_SOCKET_PATH = 100;

export interface ServicePaths {
  dir: string;
  socket: string;
  lock: string;
}

export function servicePaths(env: Env): ServicePaths {
  const dir = stateDir(env);
  return { dir, socket: join(dir, "service.sock"), lock: join(dir, "service.lock.db") };
}

/** `LLMOS_SERVICE=off` turns the service off: clients never connect to it or start it. */
export function serviceDisabled(env: Env): boolean {
  return env.LLMOS_SERVICE === "off";
}

export type Reply =
  | { kind: "ok"; result: unknown }
  | { kind: "error"; code: string; message: string }
  | { kind: "down" }
  /** The service did not answer in time, or answered something unreadable. */
  | { kind: "failed"; message: string };

function exchange(socketPath: string, line: string, timeoutMs: number): Promise<Reply> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const socket = net.connect(socketPath);
    const finish = (reply: Reply): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reply);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish({ kind: "failed", message: "no answer in time" }));
    socket.once("connect", () => socket.write(line));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const answer = JSON.parse(buffer.slice(0, newline)) as {
          ok?: unknown;
          result?: unknown;
          error?: { code?: unknown; message?: unknown };
        };
        if (answer.ok === true) finish({ kind: "ok", result: answer.result });
        else {
          finish({
            kind: "error",
            code: String(answer.error?.code ?? "internal"),
            message: String(answer.error?.message ?? "the service failed"),
          });
        }
      } catch {
        finish({ kind: "failed", message: "the answer is not JSON" });
      }
    });
    socket.once("close", () =>
      finish({ kind: "failed", message: "the service closed the socket" }),
    );
    // A socket that cannot connect (no file, or a file nobody listens on) is a service that is down.
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        socket.connecting || error.syscall === "connect"
          ? { kind: "down" }
          : { kind: "failed", message: error.message },
      ),
    );
  });
}

let nextId = 1;

/** Call `method` on the service of this host. Never throws. */
export function callService(
  env: Env,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 120_000,
): Promise<Reply> {
  if (serviceDisabled(env)) return Promise.resolve({ kind: "down" });
  const line = `${JSON.stringify({ id: nextId++, method, params })}\n`;
  return exchange(servicePaths(env).socket, line, timeoutMs);
}

/** The service's status, or null when none runs. Starts nothing. */
export async function serviceStatus(env: Env): Promise<ServiceStatus | null> {
  const reply = await callService(env, "status", {}, 5000);
  return reply.kind === "ok" ? (reply.result as ServiceStatus) : null;
}

const CLI = resolve(import.meta.dir, "..");

/**
 * Start `llmos service serve` detached, and return at once: the caller does
 * its work itself while the service starts. It runs in the install folder
 * with Bun's `.env` and `bunfig.toml` loading off, as the MCP launcher's
 * server does, because the caller's folder is the session's project.
 * Two starts at the same moment end as one service (`service.ts`).
 */
export function startService(env: Env): void {
  if (serviceDisabled(env)) return;
  if (Buffer.byteLength(servicePaths(env).socket) > MAX_SOCKET_PATH) return;
  try {
    startDetached(
      [
        process.execPath,
        "--no-install",
        "--no-env-file",
        "--config=/dev/null",
        join(CLI, "bin", "llmos.ts"),
        "service",
        "serve",
      ],
      {
        cwd: CLI,
        // libggml-metal aborts at exit with a loaded model unless this is set (bin/llmos.ts).
        env: { ...env, GGML_METAL_NO_RESIDENCY: "1" },
      },
    );
  } catch {}
}

/**
 * A searcher that asks the service and otherwise runs `local`. With `start`,
 * a missing service is started (this call still runs `local`). A refused
 * collection is the caller's answer, not a reason to run again.
 */
export function viaService(env: Env, local: Searcher, options: { start: boolean }): Searcher {
  return async (query, search) => {
    if (!(SERVICE_COLLECTIONS as readonly string[]).includes(search.collection))
      return local(query, search);
    const reply = await callService(env, "search", {
      query,
      collection: search.collection,
      limit: search.limit,
      mode: search.mode,
      index: qmdLocation(env).dbPath,
    });
    if (reply.kind === "ok" && Array.isArray(reply.result)) return reply.result;
    if (reply.kind === "down" && options.start) startService(env);
    if (reply.kind === "error" && reply.code === "collection_missing") {
      throw new QmdCollectionMissing(reply.message);
    }
    return local(query, search);
  };
}

/**
 * After a memory is saved or forgotten: bring the keyword index up to date
 * (no model), and ask a running service to embed the change in the
 * background. The index step uses the `memory` collection, else `llmos`
 * while the `memory` collection is missing. A service that is not running
 * is not started: a save never begins a model load. The note is already
 * written, so a failure here is a warning, returned as text.
 */
export async function afterMemoryWrite(env: Env): Promise<string | null> {
  const location = qmdLocation(env);
  // Never create an index just to update it.
  if (!existsSync(location.dbPath)) return null;
  let collection: string | null = null;
  try {
    const store = await openQmd(location, false);
    try {
      const names = (await store.listCollections()).map((entry) => entry.name);
      collection = names.includes(MEMORY_COLLECTION)
        ? MEMORY_COLLECTION
        : names.includes("llmos")
          ? "llmos"
          : null;
      if (collection !== null) await store.update({ collections: [collection] });
    } finally {
      await store.close();
    }
  } catch (error) {
    return `the search index was not updated: ${error instanceof Error ? error.message : error}`;
  }
  if (collection === MEMORY_COLLECTION) {
    await callService(env, "embed", { collection, index: location.dbPath }, 5000);
  }
  return null;
}
