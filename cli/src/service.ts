/**
 * The llmOS service: one long-lived process per host that keeps the qmd
 * search models loaded, so every agent session on the host shares one warm
 * model set instead of loading its own (`llmos service serve`). Clients are
 * `llmos mcp` and the search verbs (`service-client.ts`); they fall back to
 * their own store when the service is down.
 *
 * Transport: a Unix socket, `service.sock` in the llmOS state folder
 * (`heartbeat.ts` `stateDir`). The folder is mode 0700 and the socket mode
 * 0600, so only the user's own processes connect. There is no port.
 *
 * Protocol: newline-delimited JSON, one request per line and one response
 * per line, in order. A client can be a few lines of Python.
 *
 *   request   {"id": 1, "method": "search", "params": {...}}
 *   success   {"id": 1, "ok": true, "result": ...}
 *   failure   {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
 *
 * Methods:
 * - `status`: pid, start time, index path, request count, which models are
 *   loaded, whether an embed runs. Takes no params.
 * - `search`: `query`, `collection`, `limit`, `mode` (keyword, semantic, or
 *   hybrid), like `qmd.ts` `search`. Result: the hits.
 * - `embed`: `collection`. Answers at once and embeds the collection's new
 *   documents in the background, under qmd's embed lock.
 *
 * `params.index` (optional) names the qmd index the caller means. The
 * service answers `index_mismatch` when it differs from its own, so a
 * caller with another index never gets answers from this one.
 *
 * The service serves the llmOS vault's collections only. It has no shell,
 * file, or arbitrary-path method, and it checks every parameter. It stops
 * after 30 minutes without a request (`LLMOS_SERVICE_IDLE_MS` changes this).
 *
 * Start rules: a client that cannot connect starts `llmos service serve`
 * detached. Two services started together end as one: the starter holds a
 * short-lived lock file while it checks for a live service and binds, and a
 * socket file that no process listens on is removed first.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QMDStore } from "@tobilu/qmd";
import * as z from "zod";
import {
  isEmbedLockBusy,
  openQmd,
  QmdCollectionMissing,
  type QmdLocation,
  qmdLocation,
  type SearchMode,
  search,
} from "./qmd.ts";
import {
  MAX_SOCKET_PATH,
  SERVICE_COLLECTIONS,
  type ServicePaths,
  servicePaths,
} from "./service-client.ts";

export type Env = Record<string, string | undefined>;

export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
/** The longest request line the service reads. */
export const MAX_LINE_BYTES = 16 * 1024;
/** The idle limit in milliseconds. */
export function idleLimit(env: Env): number {
  const given = Number(env.LLMOS_SERVICE_IDLE_MS);
  return Number.isFinite(given) && given > 0 ? given : DEFAULT_IDLE_MS;
}

/** Another live service already holds the socket. */
export class ServiceInUse extends Error {
  override name = "ServiceInUse";
}

/** A request the service refuses; `code` tells the client why. */
export class ServiceError extends Error {
  override name = "ServiceError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects.
const CONTROL = /[\u0000-\u001f\u007f]/;
const index = z.string().min(1).max(4096).optional();
const searchParams = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(1000)
    .refine((value) => !CONTROL.test(value), "must be one line without control characters"),
  collection: z.enum(SERVICE_COLLECTIONS),
  limit: z.int().min(1).max(200),
  mode: z.enum(["keyword", "semantic", "hybrid"]),
  index,
});
const embedParams = z.strictObject({ collection: z.enum(SERVICE_COLLECTIONS), index });
const statusParams = z.strictObject({ index });
const request = z.strictObject({
  id: z.union([z.number(), z.string().max(100), z.null()]).optional(),
  method: z.string().max(40),
  params: z.record(z.string(), z.unknown()).optional(),
});

function failure(id: unknown, code: string, message: string): string {
  return `${JSON.stringify({ id: id ?? null, ok: false, error: { code, message } })}\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** Whether a process listens on the socket at `path`. */
export function socketLive(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const done = (live: boolean): void => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Hold `paths.lock` while `work` runs, so two starters never bind in turn. */
async function withStartLock<T>(paths: ServicePaths, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(paths.lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST" || attempt >= 100) throw error;
      let holder = 0;
      let age = 0;
      try {
        holder = Number.parseInt(readFileSync(paths.lock, "utf8").trim(), 10);
        age = Date.now() - statSync(paths.lock).mtimeMs;
      } catch {
        continue; // Released since the failed write.
      }
      // A starter holds the lock for milliseconds: a dead or old holder left it behind.
      if (!(holder > 0 && processAlive(holder)) || age > 10_000)
        rmSync(paths.lock, { force: true });
      else await sleep(50);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(paths.lock, { force: true });
  }
}

export interface ServiceOptions {
  env: Env;
  /** Replaces the idle limit of `env`. */
  idleMs?: number;
  /** Replaces opening the real qmd store; tests pass a stand-in. */
  openStore?: (location: QmdLocation) => Promise<QMDStore>;
  /** The wait before an embed tries again while another process holds the embed lock. */
  embedRetryMs?: number;
}

export interface RunningService {
  socket: string;
  /** Resolves when the service has stopped. */
  done: Promise<void>;
  /** Stop now: close the socket and the store. */
  close(): Promise<void>;
}

/** What `status` answers. */
export interface ServiceStatus {
  pid: number;
  started_at: string;
  index: string;
  requests: number;
  idle_stop_ms: number;
  /** Which qmd models are in memory now. */
  models: { embed: boolean; rerank: boolean; generate: boolean };
  /** Whether a background embed runs now. */
  embedding: boolean;
}

/** The loaded-model flags of a qmd store, read from qmd's own LLM object. */
function loadedModels(store: QMDStore | null): ServiceStatus["models"] {
  const llm = (store?.internal.llm ?? {}) as Record<string, unknown>;
  const loaded = (name: string): boolean => llm[name] != null;
  return {
    embed: loaded("embedModel"),
    rerank: loaded("rerankModel"),
    generate: loaded("generateModel"),
  };
}

/** Whether a qmd embedding model file is in qmd's model cache (`$XDG_CACHE_HOME/qmd/models`). */
function embeddingModelOnDisk(env: Env): boolean {
  const cache = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  try {
    return readdirSync(join(cache, "qmd", "models")).some(
      (name) => name.endsWith(".gguf") && /embed/i.test(name),
    );
  } catch {
    return false;
  }
}

class Service {
  private store: Promise<QMDStore> | null = null;
  private opened: QMDStore | null = null;
  private requests = 0;
  private readonly startedAt = new Date().toISOString();
  private readonly pendingEmbeds = new Set<string>();
  private embedding = false;
  private closed = false;
  readonly location: QmdLocation;

  constructor(
    private readonly options: ServiceOptions,
    readonly idleMs: number,
  ) {
    this.location = qmdLocation(options.env);
  }

  /** Whether a background embed runs or waits; requests are not counted. */
  get busy(): boolean {
    return this.embedding || this.pendingEmbeds.size > 0;
  }

  private openStore(): Promise<QMDStore> {
    if (this.store === null) {
      if (!existsSync(this.location.dbPath)) {
        return Promise.reject(
          new ServiceError("no_index", `no qmd index at ${this.location.dbPath}`),
        );
      }
      const open = this.options.openStore ?? ((location) => openQmd(location, false));
      this.store = open(this.location).then((store) => {
        // The service decides when the models go: after its own idle stop, not qmd's 5 minutes.
        const llm = store.internal.llm as unknown as { inactivityTimeoutMs?: number } | undefined;
        if (llm) llm.inactivityTimeoutMs = 0;
        this.opened = store;
        return store;
      });
      this.store.catch(() => {
        this.store = null;
      });
    }
    return this.store;
  }

  /**
   * Load the embedding model before the first request needs it. Best
   * effort, and only when the model is already on disk: a warm-up never
   * downloads a model.
   */
  async warm(): Promise<void> {
    try {
      if (!embeddingModelOnDisk(this.options.env)) return;
      const store = await this.openStore();
      await store.searchVector("warm up", { limit: 1 });
    } catch {
      // No index yet, or no model: the first request reports it.
    }
  }

  private checkIndex(params: { index?: string | undefined }): void {
    if (params.index !== undefined && params.index !== this.location.dbPath) {
      throw new ServiceError(
        "index_mismatch",
        `this service serves ${this.location.dbPath}, not ${params.index}`,
      );
    }
  }

  status(): ServiceStatus {
    return {
      pid: process.pid,
      started_at: this.startedAt,
      index: this.location.dbPath,
      requests: this.requests,
      idle_stop_ms: this.idleMs,
      models: loadedModels(this.opened),
      embedding: this.embedding,
    };
  }

  /** Answer one request object; throws `ServiceError` for a request it refuses. */
  async handle(method: string, rawParams: unknown): Promise<unknown> {
    this.requests++;
    switch (method) {
      case "status": {
        this.checkIndex(statusParams.parse(rawParams ?? {}));
        return this.status();
      }
      case "search": {
        const params = searchParams.parse(rawParams);
        this.checkIndex(params);
        const store = await this.openStore();
        try {
          return await search(store, params.query, {
            collection: params.collection,
            limit: params.limit,
            mode: params.mode as SearchMode,
          });
        } catch (error) {
          if (error instanceof QmdCollectionMissing) {
            throw new ServiceError("collection_missing", error.message);
          }
          throw error;
        }
      }
      case "embed": {
        const params = embedParams.parse(rawParams);
        this.checkIndex(params);
        await this.openStore();
        this.pendingEmbeds.add(params.collection);
        void this.drainEmbeds();
        return { accepted: true };
      }
      default:
        throw new ServiceError("unknown_method", `unknown method '${method.slice(0, 40)}'`);
    }
  }

  /** Embed each requested collection in turn, one embed at a time. */
  private async drainEmbeds(): Promise<void> {
    if (this.embedding) return;
    this.embedding = true;
    try {
      while (!this.closed) {
        const collection = this.pendingEmbeds.values().next().value;
        if (collection === undefined) break;
        this.pendingEmbeds.delete(collection);
        await this.embedOnce(collection);
      }
    } finally {
      this.embedding = false;
    }
  }

  /**
   * Embed `collection`; qmd's embed lock keeps it from racing a manual
   * `llmos reindex`. While another process holds the lock, wait and try again:
   * that process may have scanned the collection before the change.
   */
  private async embedOnce(collection: string): Promise<void> {
    const store = await this.openStore();
    const wait = this.options.embedRetryMs ?? 5000;
    for (let attempt = 0; attempt < 24 && !this.closed; attempt++) {
      try {
        await store.embed({ collection });
        return;
      } catch (error) {
        if (!isEmbedLockBusy(error)) {
          process.stderr.write(`llmos service: embed of ${collection} failed: ${error}\n`);
          return;
        }
        await sleep(wait);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const store = this.store;
    this.store = null;
    this.opened = null;
    if (store) await (await store.catch(() => null))?.close();
  }
}

/** One response line for one request line. */
async function respond(service: Service, line: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, "bad_request", "request is not JSON");
  }
  const checked = request.safeParse(parsed);
  const id = (parsed as { id?: unknown } | null)?.id;
  if (!checked.success) {
    return failure(
      typeof id === "number" || typeof id === "string" ? id : null,
      "bad_request",
      checked.error.issues
        .map((issue) => `${issue.path.join(".") || "(request)"}: ${issue.message}`)
        .join("; "),
    );
  }
  try {
    const result = await service.handle(checked.data.method, checked.data.params);
    return `${JSON.stringify({ id: checked.data.id ?? null, ok: true, result })}\n`;
  } catch (error) {
    if (error instanceof ServiceError) {
      return failure(checked.data.id, error.code, error.message);
    }
    if (error instanceof z.ZodError) {
      return failure(
        checked.data.id,
        "bad_request",
        error.issues
          .map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`)
          .join("; "),
      );
    }
    return failure(checked.data.id, "internal", error instanceof Error ? error.message : "failed");
  }
}

/**
 * Bind the socket and serve until the idle limit passes or `close` is
 * called. Throws `ServiceInUse` when another live service holds the socket.
 */
export async function serveService(options: ServiceOptions): Promise<RunningService> {
  const paths = servicePaths(options.env);
  if (Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH) {
    throw new Error(`the socket path is too long for a Unix socket: ${paths.socket}`);
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  const service = new Service(options, options.idleMs ?? idleLimit(options.env));
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "";
    let chain: Promise<unknown> = Promise.resolve();
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        chain = chain.then(async () => {
          idle();
          const reply =
            Buffer.byteLength(line) > MAX_LINE_BYTES
              ? failure(null, "bad_request", `request is longer than ${MAX_LINE_BYTES} bytes`)
              : await respond(service, line);
          if (!socket.destroyed) socket.write(reply);
          idle();
        });
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        buffer = "";
        socket.end(failure(null, "bad_request", `request is longer than ${MAX_LINE_BYTES} bytes`));
      }
    });
  });

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping: Promise<void> | null = null;
  const close = (): Promise<void> => {
    stopping ??= (async () => {
      if (timer) clearTimeout(timer);
      server.close();
      for (const socket of connections) socket.destroy();
      rmSync(paths.socket, { force: true });
      await service.close();
      resolveDone();
    })();
    return stopping;
  };
  function idle(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // A background embed is work: stop after it, not in the middle of it.
      if (service.busy) idle();
      else void close();
    }, service.idleMs);
  }

  await withStartLock(paths, async () => {
    if (await socketLive(paths.socket)) {
      throw new ServiceInUse(`a service already listens on ${paths.socket}`);
    }
    // No process listens on a socket file that is left: remove it, then bind.
    rmSync(paths.socket, { force: true });
    const umask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(paths.socket, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } finally {
      process.umask(umask);
    }
    chmodSync(paths.socket, 0o600);
  });
  idle();
  void service.warm();
  return { socket: paths.socket, done, close };
}
