/**
 * The llmOS service on real Unix sockets and real child processes: the
 * protocol, start on first use, one service when starts race, stale-socket
 * recovery, the idle stop, the fallback, and the background embed. Searches
 * are keyword searches and the embed uses a store stand-in, so no model is
 * needed; the warm-model behavior is shown by a probe, not here.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { QMDStore } from "@tobilu/qmd";
import { QmdCollectionMissing, type Searcher, type SearchHit } from "../src/qmd.ts";
import { serveService } from "../src/service.ts";
import { callService, servicePaths, serviceStatus, viaService } from "../src/service-client.ts";
import { cli, indexVault, isolatedEnv, makeVault } from "./helpers.ts";

const NOTES = {
  "notes/alpha.md": "# Alpha\n\nThe zebrafish tank needs a heater.\n",
  "projects/demo/memory/tank.md":
    "---\nname: tank\ndescription: tank\nmetadata:\n  node_type: memory\n  type: project\n---\n\nThe zebrafish tank needs a heater.\n",
};

const envs: Record<string, string>[] = [];

/** An environment with the service on and a short state folder (a socket path has a length limit). */
function liveEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = isolatedEnv({
    LLMOS_SERVICE: "on",
    XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "ls-")),
    // A safety net: a service a test leaves behind stops by itself.
    LLMOS_SERVICE_IDLE_MS: "60000",
    ...extra,
  });
  envs.push(env);
  return env;
}

afterAll(async () => {
  for (const env of envs) {
    const status = await serviceStatus(env);
    if (status) process.kill(status.pid, "SIGTERM");
  }
});

async function waitFor<T>(what: string, probe: () => Promise<T | null | false> | T | null | false) {
  for (let i = 0; i < 200; i++) {
    const found = await probe();
    if (found) return found;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Send raw lines on one connection; resolve with the first `count` response lines. */
function raw(
  socket: string,
  lines: string[],
  count = lines.length,
): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socket);
    let buffer = "";
    client.setEncoding("utf8");
    client.on("error", reject);
    client.on("connect", () => client.write(lines.join("")));
    client.on("data", (chunk: string) => {
      buffer += chunk;
      const got = buffer.split("\n").filter(Boolean);
      if (got.length >= count) {
        client.destroy();
        resolve(got.map((line) => JSON.parse(line)));
      }
    });
  });
}

async function indexedEnv(env = liveEnv()) {
  const root = makeVault(NOTES);
  await indexVault(root, env, { llmos: "**/*.md" });
  return { root, env };
}

describe("the protocol", () => {
  test("answers a keyword search, and refuses every bad request", async () => {
    const { env } = await indexedEnv();
    const service = await serveService({ env });
    const index = env.INDEX_PATH as string;
    const search = (params: object) =>
      `${JSON.stringify({ id: 7, method: "search", params: { query: "zebrafish", collection: "llmos", limit: 5, mode: "keyword", ...params } })}\n`;
    const [ok = {}, ...bad] = await raw(service.socket, [
      search({}),
      "not json\n",
      `${JSON.stringify({ params: {} })}\n`,
      `${JSON.stringify({ id: 1, method: "read", params: { note: "x" } })}\n`,
      search({ collection: "xbrain" }),
      search({ path: "/etc/passwd" }),
      search({ limit: 0 }),
      search({ mode: "deep" }),
      search({ index: `${index}.other` }),
      search({ collection: "memory" }),
      `${JSON.stringify({ id: 2, method: "search", params: { query: "x".repeat(20_000) } })}\n`,
    ]);
    expect(ok).toMatchObject({ id: 7, ok: true });
    expect(ok.result.map((hit: SearchHit) => hit.path)).toEqual([
      "notes/alpha.md",
      "projects/demo/memory/tank.md",
    ]);
    expect(bad.map((reply) => [reply.ok, reply.error.code])).toEqual([
      [false, "bad_request"],
      [false, "bad_request"],
      [false, "unknown_method"],
      [false, "bad_request"],
      [false, "bad_request"],
      [false, "bad_request"],
      [false, "bad_request"],
      [false, "index_mismatch"],
      [false, "collection_missing"],
      [false, "bad_request"],
    ]);
    await service.close();
  });

  test("the folder is private and the socket is mode 0600", async () => {
    const { env } = await indexedEnv();
    const service = await serveService({ env });
    expect(statSync(dirname(service.socket)).mode & 0o777).toBe(0o700);
    expect(statSync(service.socket).mode & 0o777).toBe(0o600);
    await service.close();
  });
});

describe("start and stop", () => {
  test("a client that finds no service starts one, answers itself, and the next call uses the service", async () => {
    const { env } = await indexedEnv();
    const local: Searcher = async () => [
      { path: "local.md", title: "", score: 0, line: 1, snippet: "" },
    ];
    const ask = viaService(env, local, { start: true });
    const options = { collection: "llmos", limit: 5, mode: "keyword" } as const;

    expect((await ask("zebrafish", options))[0]?.path).toBe("local.md");
    await waitFor("the service", () => serviceStatus(env));

    const hits = await ask("zebrafish", options);
    expect(hits[0]?.path).toBe("notes/alpha.md");
  });

  test("a client that only uses the service never starts one", async () => {
    const { env } = await indexedEnv();
    const local: Searcher = async () => [];
    await viaService(env, local, { start: false })("zebrafish", {
      collection: "llmos",
      limit: 5,
      mode: "keyword",
    });
    await Bun.sleep(500);
    expect(await serviceStatus(env)).toBeNull();
    expect(existsSync(servicePaths(env).socket)).toBe(false);
  });

  test("starts that race end as one service", async () => {
    const { env } = await indexedEnv();
    const children = Array.from({ length: 5 }, () =>
      Bun.spawn([process.execPath, join(import.meta.dir, "../bin/llmos.ts"), "service", "serve"], {
        // Without this, bin/llmos.ts starts the service as a child of a wrapper process.
        env: { ...env, GGML_METAL_NO_RESIDENCY: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const status = await waitFor("the service", () => serviceStatus(env));
    // Every loser exits at once with status 0; the one winner keeps running.
    await Bun.sleep(1500);
    const alive = children.filter((child) => child.exitCode === null);
    expect(alive.map((child) => child.pid)).toEqual([status.pid]);
    for (const child of children) if (child.exitCode !== null) expect(child.exitCode).toBe(0);
    process.kill(status.pid, "SIGTERM");
    await Promise.all(children.map((child) => child.exited));
  });

  test("a socket file that no process listens on is replaced", async () => {
    const { env } = await indexedEnv();
    const { socket, dir } = servicePaths(env);
    mkdirSync(dir, { recursive: true });
    // A process binds the socket and dies without cleaning up, as a crash does.
    const crashed = Bun.spawn(
      [
        "bun",
        "-e",
        `require("net").createServer().listen(${JSON.stringify(socket)}, () => console.log("up"))`,
      ],
      { stdout: "pipe" },
    );
    await waitFor("the socket file", () => existsSync(socket));
    crashed.kill("SIGKILL");
    await crashed.exited;
    expect(existsSync(socket)).toBe(true);

    const service = await serveService({ env });
    const reply = await callService(env, "status");
    expect(reply.kind).toBe("ok");
    await service.close();
  });

  test("stops after the idle limit, and each request restarts the clock", async () => {
    const { env } = await indexedEnv();
    const service = await serveService({ env, idleMs: 400 });
    let stopped = false;
    void service.done.then(() => {
      stopped = true;
    });
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(200);
      expect((await callService(env, "status")).kind).toBe("ok");
    }
    expect(stopped).toBe(false);
    await waitFor("the idle stop", () => stopped);
    expect(existsSync(servicePaths(env).socket)).toBe(false);
    expect((await callService(env, "status")).kind).toBe("down");
  });
});

describe("the fallback", () => {
  const options = { collection: "llmos", limit: 5, mode: "keyword" } as const;
  const hit = { path: "local.md", title: "", score: 0, line: 1, snippet: "" };

  test("runs in process when no service runs, or the service is switched off", async () => {
    const down = liveEnv();
    expect(await viaService(down, async () => [hit], { start: false })("q", options)).toEqual([
      hit,
    ]);
    const off = liveEnv({ LLMOS_SERVICE: "off" });
    expect(await viaService(off, async () => [hit], { start: true })("q", options)).toEqual([hit]);
    expect(await serviceStatus(off)).toBeNull();
  });

  test("runs in process when the service cannot start", async () => {
    const env = liveEnv();
    // The state folder cannot be made: its parent is a file.
    writeFileSync(join(env.XDG_STATE_HOME as string, "blocked"), "");
    env.XDG_STATE_HOME = join(env.XDG_STATE_HOME as string, "blocked");
    expect(await viaService(env, async () => [hit], { start: true })("q", options)).toEqual([hit]);
  });

  test("runs in process when the service fails the request, but passes on a missing collection", async () => {
    const env = liveEnv();
    const { socket, dir } = servicePaths(env);
    mkdirSync(dir, { recursive: true });
    let code = "internal";
    const fake = net.createServer((client) =>
      client.on("data", () =>
        client.write(`${JSON.stringify({ id: 1, ok: false, error: { code, message: "boom" } })}\n`),
      ),
    );
    await new Promise<void>((resolve) => fake.listen(socket, resolve));
    const ask = viaService(env, async () => [hit], { start: true });
    expect(await ask("q", options)).toEqual([hit]);
    code = "collection_missing";
    await expect(ask("q", options)).rejects.toBeInstanceOf(QmdCollectionMissing);
    fake.close();
  });

  test("the search verb answers from the service when it runs", async () => {
    const { root, env } = await indexedEnv();
    const service = await serveService({ env });
    const result = await cli(root, ["search", "zebrafish"], { env });
    expect(JSON.parse(result.stdout).map((entry: SearchHit) => entry.path)).toContain(
      "notes/alpha.md",
    );
    expect((await serviceStatus(env))?.requests).toBeGreaterThanOrEqual(2);
    await service.close();
  });
});

describe("memory writes", () => {
  /** A service whose store records embeds; the real index is behind it. */
  async function recordingService(
    env: Record<string, string>,
    embeds: string[],
    lockHeld = () => false,
  ) {
    const { openQmd, qmdLocation } = await import("../src/qmd.ts");
    return serveService({
      env,
      embedRetryMs: 30,
      openStore: async (location) => {
        const real = await openQmd(location, false);
        return {
          internal: real.internal,
          listCollections: () => real.listCollections(),
          searchVector: async () => [],
          embed: async ({ collection }: { collection: string }) => {
            embeds.push(
              `${collection}${existsSync(join(dirname(qmdLocation(env).dbPath), ".qmd-embed.lock")) ? " locked" : ""}${lockHeld() ? " raced" : ""}`,
            );
            return {};
          },
          close: () => real.close(),
        } as unknown as QMDStore;
      },
    });
  }

  const SAVE = ["memory", "save", "pump", "The pump", "The sump pump hums.", "--project", "demo"];

  test("a save updates the keyword index at once, with or without the memory collection", async () => {
    const configs: Record<string, string>[] = [
      { llmos: "**/*.md", memory: "projects/*/memory/*.md" },
      { llmos: "**/*.md" },
    ];
    for (const collections of configs) {
      const root = makeVault(NOTES);
      const env = isolatedEnv();
      await indexVault(root, env, collections);
      const saved = await cli(root, SAVE, { env });
      expect(saved.exitCode).toBe(0);
      const found = await cli(
        root,
        ["memory", "search", "sump", "--keyword", "--project", "demo"],
        { env },
      );
      expect(JSON.parse(found.stdout).map((entry: SearchHit) => entry.path)).toEqual([
        "projects/demo/memory/pump.md",
      ]);
      const forgot = await cli(root, ["memory", "forget", "pump", "--project", "demo"], { env });
      expect(forgot.exitCode).toBe(0);
      const gone = await cli(root, ["memory", "search", "sump", "--keyword", "--project", "demo"], {
        env,
      });
      expect(JSON.parse(gone.stdout)).toEqual([]);
    }
  });

  test("a save asks a running service to embed the memory collection, under the embed lock", async () => {
    const root = makeVault(NOTES);
    const env = liveEnv();
    await indexVault(root, env, { llmos: "**/*.md", memory: "projects/*/memory/*.md" });
    const embeds: string[] = [];
    const service = await recordingService(env, embeds);
    expect((await cli(root, SAVE, { env })).exitCode).toBe(0);
    await waitFor("the embed", () => embeds.length > 0);
    expect(embeds).toEqual(["memory locked"]);
    await service.close();
  });

  test("an embed waits while another process holds the embed lock", async () => {
    const root = makeVault(NOTES);
    const env = liveEnv();
    await indexVault(root, env, { llmos: "**/*.md", memory: "projects/*/memory/*.md" });
    const lock = join(dirname(env.INDEX_PATH as string), ".qmd-embed.lock");
    writeFileSync(lock, `${process.pid}\n`);
    const embeds: string[] = [];
    const service = await recordingService(env, embeds);
    await callService(env, "embed", { collection: "memory" });
    await Bun.sleep(300);
    expect(embeds).toEqual([]);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(lock);
    await waitFor("the embed", () => embeds.length > 0);
    await service.close();
  });

  test("a save with no service running starts none", async () => {
    const root = makeVault(NOTES);
    const env = liveEnv();
    await indexVault(root, env, { llmos: "**/*.md", memory: "projects/*/memory/*.md" });
    expect((await cli(root, SAVE, { env })).exitCode).toBe(0);
    await Bun.sleep(500);
    expect(await serviceStatus(env)).toBeNull();
  });
});
