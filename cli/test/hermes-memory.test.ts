/**
 * The Hermes memory provider (`hermes/memory_provider.py`), run by `python3`
 * with a stub of Hermes's `agent.memory_provider` module. It calls this
 * checkout's `llmos` CLI on a temporary vault and qmd index, as Hermes would.
 * The index has no vectors, so semantic recall finds nothing and loads no model;
 * the recall pool comes from the word match, and a stub Clef server judges it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { indexVault, isolatedEnv, makeVault, read, scratch, TOOLS } from "./helpers.ts";

const DRIVER = `
import importlib.util, json, logging, random, sys, time
stub, provider_file = sys.argv[1], sys.argv[2]
sys.path.insert(0, stub)
spec = importlib.util.spec_from_file_location("llmos_memory_provider", provider_file)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.loads(sys.stdin.read())
records = []
class Capture(logging.Handler):
    def emit(self, record):
        records.append([record.levelname, record.getMessage()])
module.LOG.addHandler(Capture())
module.LOG.setLevel(logging.DEBUG)
provider = module.LlmosMemoryProvider()
if "search_hits" in request:
    # Canned semantic hits in place of llmos memory search, in the service's order.
    real_llmos = provider._llmos
    def fake_llmos(*args):
        if args[:2] == ("memory", "search"):
            return request["search_hits"], None
        return real_llmos(*args)
    provider._llmos = fake_llmos
provider.initialize("session", **request["init"])
out = {"available": provider.is_available(), "prompt": provider.system_prompt_block(),
       "tools": [schema["name"] for schema in provider.get_tool_schemas()], "calls": []}
for name, args in request["calls"]:
    out["calls"].append(json.loads(provider.handle_tool_call(name, args)))
out["recalls"] = []
out["queue_seconds"] = []
for step in request.get("recalls", []):
    if step[0] == "queue":
        started = time.monotonic()
        provider.queue_prefetch(step[1], session_id=step[2])
        from agent.memory_provider import THREADS
        for thread in THREADS:
            thread.join()
        out["queue_seconds"].append(time.monotonic() - started)
    else:
        block = provider.prefetch("next turn", session_id=step[1])
        status = provider.recall_status()
        out["recalls"].append({"block": block, "count": status.count if status else None})
if "shuffle" in request:
    # The evaluation's order: the sorted pool, shuffled by a generator seeded with the text.
    paths = sorted(request["shuffle"]["paths"])
    random.Random(request["shuffle"]["seed"]).shuffle(paths)
    out["shuffled"] = paths
out["logs"] = records
out["query"] = module._query(request.get("query", ""))
print(json.dumps(out))
`;

const STUB = `
import threading
from dataclasses import dataclass

THREADS = []

class MemoryProvider:
    pass

@dataclass(frozen=True)
class RecallStatus:
    provider_label: str
    count: int

def is_trivial_prompt(text):
    return (text or "").strip().lower() in {"", "thanks", "ok", "yes"}

def spawn_context_thread(target, *, name, args=()):
    thread = threading.Thread(target=target, name=name, args=args)
    THREADS.append(thread)
    return thread
`;

interface Run {
  available: boolean;
  prompt: string;
  tools: string[];
  calls: Record<string, unknown>[];
  recalls: { block: string; count: number | null }[];
  queue_seconds: number[];
  shuffled?: string[];
  logs: [string, string][];
  query: string;
}

function python(): string | null {
  return Bun.which("python3");
}

function setup(): { root: string; driver: string; stub: string; env: Record<string, string> } {
  const root = makeVault({
    "projects/my-repo/my-repo.md": "# my-repo\n",
    "projects/my-repo/memory/MEMORY.md": "# Memory index\n\n- [Old](old.md) — an old memory\n",
    "projects/personal/personal.md": "# personal\n",
  });
  const folder = scratch("hermes");
  const stub = join(folder, "stub");
  mkdirSync(join(stub, "agent"), { recursive: true });
  writeFileSync(join(stub, "agent", "__init__.py"), "");
  writeFileSync(join(stub, "agent", "memory_provider.py"), STUB);
  const driver = join(folder, "driver.py");
  writeFileSync(driver, DRIVER);
  const env = isolatedEnv({ LLMOS_ROOT: root, PATH: process.env.PATH ?? "/usr/bin:/bin" });
  return { root, driver, stub, env };
}

// Async, so the stub Clef server in this process can answer while Python runs.
async function run(
  setupResult: ReturnType<typeof setup>,
  init: Record<string, unknown>,
  calls: [string, Record<string, unknown>][] = [],
  more: {
    recalls?: string[][];
    search_hits?: { path: string; score: number }[];
    shuffle?: { seed: string; paths: string[] };
    query?: string;
    env?: Record<string, string>;
  } = {},
): Promise<Run> {
  const { env, ...request } = more;
  const proc = Bun.spawn({
    cmd: [
      python() as string,
      "-I",
      setupResult.driver,
      setupResult.stub,
      join(TOOLS, "hermes", "memory_provider.py"),
    ],
    stdin: Buffer.from(JSON.stringify({ init, calls, ...request })),
    env: { ...setupResult.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) throw new Error(stderr);
  return JSON.parse(stdout) as Run;
}

interface ClefBody {
  model: string;
  state: string;
  questions: Record<string, { instructions: string }>;
}

type ClefMode =
  | "ok"
  | "http500"
  | "slow"
  | "drip"
  | "missing-field"
  | "non-numeric"
  | "deep"
  | "huge";

/** A stub Clef endpoint. `helpful` maps a note's file name to its probability. */
const servers: { stop(force: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function stubClef(helpful: Record<string, number>, mode: (call: number) => ClefMode = () => "ok") {
  const requests: { path: string; method: string; body: ClefBody }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as ClefBody;
      requests.push({ path: new URL(req.url).pathname, method: req.method, body });
      const behavior = mode(requests.length);
      if (behavior === "http500") return new Response("boom", { status: 500 });
      if (behavior === "slow") await Bun.sleep(2000);
      if (behavior === "drip") {
        // Headers at once, then one byte of body every 100 ms, without end.
        const space = new TextEncoder().encode(" ");
        const stream = new ReadableStream({
          async pull(controller) {
            await Bun.sleep(100);
            controller.enqueue(space);
          },
        });
        return new Response(stream, { headers: { "Content-Type": "application/json" } });
      }
      // 500,000 levels overflow the JSON decoder's stack on Python 3.9 and 3.14, and
      // the body (1,000,000 bytes) stays under the provider's 1 MiB cap.
      if (behavior === "deep") return new Response(`${"[".repeat(500_000)}${"]".repeat(500_000)}`);
      const answers: Record<string, unknown> = {};
      for (const [label, question] of Object.entries(body.questions)) {
        const name = /\((.+?\.md)\)/.exec(question.instructions)?.[1] ?? "";
        const p = behavior === "non-numeric" ? "high" : (helpful[name] ?? 0);
        answers[label] = { type: "choice", probabilities: { helpful: p, noise: 1 - Number(p) } };
      }
      if (behavior === "missing-field") delete answers.m2;
      // A valid answer, padded past the provider's 1 MiB cap.
      if (behavior === "huge") return Response.json({ answers, pad: "x".repeat(2 << 20) });
      return Response.json({ answers });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

/** Recalled note names, in block order. */
function recalledNames(block: string): string[] {
  return [...block.matchAll(/^### projects\/my-repo\/memory\/(\S+)\.md/gm)].map(
    (m) => m[1] as string,
  );
}

const clefLogs = (out: Run) => out.logs.filter(([, message]) => message.includes("Clef"));

const ZEBRA = ["alpha", "bravo", "charlie", "delta", "echo"];
/** Notes no word of TURN matches; only canned semantic hits bring them into the pool. */
const OTHER = ["golf", "hotel", "india", "juliet", "kilo"];

/** A project whose five ZEBRA notes share the word "zebrafish", so the word match pools them all. */
async function zebraSetup() {
  const note = (text: string) =>
    `---\nname: x\ndescription: x\nmetadata:\n  type: project\n---\n\n${text}\n`;
  const root = makeVault({
    "projects/my-repo/my-repo.md": "# my-repo\n",
    "projects/my-repo/memory/MEMORY.md": "# Memory index\n",
    ...Object.fromEntries(
      ZEBRA.map((name) => [
        `projects/my-repo/memory/${name}.md`,
        note(`The ${name} zebrafish rule.`),
      ]),
    ),
    ...Object.fromEntries(
      OTHER.map((name) => [`projects/my-repo/memory/${name}.md`, note(`The ${name} note.`)]),
    ),
  });
  const setupResult = { ...setup(), root };
  setupResult.env.LLMOS_ROOT = root;
  await indexVault(root, setupResult.env, { llmos: "**/*.md", memory: "projects/*/memory/*.md" });
  return setupResult;
}

const TURN = "What does the zebrafish rule say?";
/** Canned semantic hits, highest score first, as the service returns them. */
const hits = (...pairs: [string, number][]) =>
  pairs.map(([name, score]) => ({ path: `projects/my-repo/memory/${name}.md`, score }));
/** Note names in the order of the request's fields m1, m2, ... */
const askedNames = (body: ClefBody) =>
  Object.values(body.questions).map((q) => /\((.+?)\.md\)/.exec(q.instructions)?.[1]);
const recallOnce = (n: number) => Array.from({ length: n }, (_, i) => ["queue", TURN, `chat${i}`]);

function gitRepo(name: string): string {
  const repo = join(scratch("repo"), name);
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync({ cmd: ["git", "init", "--quiet", repo] });
  return repo;
}

describe.skipIf(python() === null)("Hermes memory provider", () => {
  test("a chat in a vault project's repository gets its index and saves there", async () => {
    const setupResult = setup();
    const repo = gitRepo("my-repo");
    const out = await run(setupResult, { cwd: repo, agent_context: "primary" }, [
      [
        "memory_save",
        {
          name: "list-style",
          description: "How the user wants lists",
          body: "- Use short bullets.\n- One idea each.",
          type: "feedback",
        },
      ],
      ["memory_forget", { name: "old" }],
    ]);

    expect(out.available).toBe(true);
    expect(out.tools).toEqual(["memory_save", "memory_search", "memory_forget"]);
    expect(out.prompt).toContain("projects/my-repo/memory/ (project my-repo)");
    expect(out.prompt).toContain("Use memory_save for a fact another agent");
    expect(out.prompt).toContain("built-in memory tool only for facts that only Hermes");
    expect(out.prompt).toContain("- [Old](old.md) — an old memory");
    expect(out.calls[0]).toMatchObject({ path: "projects/my-repo/memory/list-style.md" });
    // A body that starts with "-" stays the body, not an option.
    expect(read(setupResult.root, "projects/my-repo/memory/list-style.md")).toContain(
      "- Use short bullets.",
    );
    expect(out.calls[1]).toMatchObject({ path: "projects/my-repo/memory/old.md" });
    expect(read(setupResult.root, "projects/my-repo/memory/MEMORY.md")).not.toContain("old.md");
  });

  test("a chat with no folder uses personal memory", async () => {
    const setupResult = setup();
    const out = await run(setupResult, { agent_workspace: "hermes" }, [
      ["memory_save", { name: "tea", description: "Tea order", body: "Green tea.", type: "user" }],
    ]);
    expect(out.prompt).toContain("projects/personal/memory/ (project personal)");
    expect(existsSync(join(setupResult.root, "projects/personal/memory/tea.md"))).toBe(true);
  });

  test("a subagent or cron session reads memory but does not write it", async () => {
    const setupResult = setup();
    const repo = gitRepo("my-repo");
    for (const agentContext of ["subagent", "cron", "flush"]) {
      const out = await run(setupResult, { cwd: repo, agent_context: agentContext }, [
        ["memory_save", { name: "x", description: "d", body: "b", type: "project" }],
        ["memory_forget", { name: "old" }],
      ]);
      expect(out.prompt).toContain("- [Old](old.md)");
      expect(out.calls.every((call) => typeof call.error === "string")).toBe(true);
    }
    expect(existsSync(join(setupResult.root, "projects/my-repo/memory/x.md"))).toBe(false);
    expect(read(setupResult.root, "projects/my-repo/memory/MEMORY.md")).toContain("old.md");
  });

  test("a refused save returns the CLI's error as JSON", async () => {
    const setupResult = setup();
    const out = await run(setupResult, { cwd: gitRepo("my-repo") }, [
      ["memory_save", { name: "../escape", description: "d", body: "b", type: "project" }],
    ]);
    expect(String(out.calls[0]?.error)).toContain("name must be a lowercase slug");
  });

  test("after a turn, the next turn gets the matching notes of its own project once", async () => {
    const note = (text: string) =>
      `---\nname: x\ndescription: x\nmetadata:\n  type: project\n---\n\n${text}\n`;
    const root = makeVault({
      "projects/my-repo/my-repo.md": "# my-repo\n",
      "projects/my-repo/memory/MEMORY.md": "# Memory index\n\n- zebrafish heater index line\n",
      "projects/my-repo/memory/tank.md": note("The zebrafish tank needs a heater at 28 C."),
      "projects/my-repo/memory/other.md": note("Unrelated: lists use short bullets."),
      "projects/personal/personal.md": "# personal\n",
      "projects/personal/memory/tank.md": note("A personal zebrafish heater."),
    });
    const setupResult = { ...setup(), root };
    setupResult.env.LLMOS_ROOT = root;
    await indexVault(root, setupResult.env, {
      llmos: "**/*.md",
      memory: "projects/*/memory/*.md",
    });
    const clef = stubClef({ "tank.md": 0.9, "other.md": 0.9 });
    const out = await run(setupResult, { cwd: gitRepo("my-repo") }, [], {
      env: { LLMOS_CLEF_URL: clef.url },
      recalls: [
        ["queue", "What temperature does the zebrafish heater need?", "chat"],
        ["prefetch", "other-chat"],
        ["prefetch", "chat"],
        ["prefetch", "chat"],
        ["queue", "thanks", "chat"],
        ["prefetch", "chat"],
      ],
    });

    // Another session of the same provider gets nothing.
    expect(out.recalls[0]).toEqual({ block: "", count: null });
    const recalled = out.recalls[1];
    expect(recalled?.count).toBe(1);
    expect(recalled?.block).toContain("### projects/my-repo/memory/tank.md");
    expect(recalled?.block).toContain("needs a heater at 28 C.");
    expect(recalled?.block).not.toContain("metadata:");
    expect(recalled?.block).not.toContain("personal");
    expect(recalled?.block).not.toContain("MEMORY.md");
    // The block is used once; a trivial prompt starts no recall.
    expect(out.recalls[2]).toEqual({ block: "", count: null });
    expect(out.recalls[3]).toEqual({ block: "", count: null });
  });

  test("recall keeps the notes Clef rates helpful, best first, and sends one request", async () => {
    const setupResult = await zebraSetup();
    // 0.3 is kept and 0.29 dropped; the best note sorts last by path; equal
    // probabilities order by path.
    const clef = stubClef({
      "alpha.md": 0.3,
      "bravo.md": 0.3,
      "charlie.md": 0.29,
      "delta.md": 0.3,
      "echo.md": 0.9,
    });
    const out = await run(setupResult, { cwd: gitRepo("my-repo") }, [], {
      env: { LLMOS_CLEF_URL: `${clef.url}/` },
      recalls: [
        ["queue", TURN, "chat"],
        ["prefetch", "chat"],
      ],
    });

    expect(clef.requests).toHaveLength(1);
    const request = clef.requests[0] as (typeof clef.requests)[number];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/systemone");
    expect(request.body.model).toBe("clef-flash");
    expect(Object.keys(request.body.questions)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(request.body.state).toContain(TURN);
    expect(askedNames(request.body).sort()).toEqual(ZEBRA);
    expect(recalledNames(out.recalls[0]?.block ?? "")).toEqual(["echo", "alpha", "bravo", "delta"]);
    expect(out.recalls[0]?.count).toBe(4);
    expect(clefLogs(out)).toEqual([]);
  });

  test("the request orders the notes by a shuffle seeded with the message it carries", async () => {
    const clef = stubClef({});
    const message = "What does the\nzebrafish rule say?";
    const out = await run(await zebraSetup(), { cwd: gitRepo("my-repo") }, [], {
      env: { LLMOS_CLEF_URL: clef.url },
      recalls: [["queue", `  ${message}  `, "chat"]],
      shuffle: { seed: message, paths: ZEBRA },
    });
    const body = clef.requests[0]?.body as ClefBody;
    expect(body.state).toContain(`<<<\n${message}\n>>>`);
    expect(askedNames(body)).toEqual(out.shuffled as string[]);
  });

  test("recall keeps at most five notes", async () => {
    const all = [...ZEBRA, ...OTHER];
    const clef = stubClef(Object.fromEntries(all.map((name) => [`${name}.md`, 0.9])));
    const out = await run(await zebraSetup(), { cwd: gitRepo("my-repo") }, [], {
      env: { LLMOS_CLEF_URL: clef.url },
      search_hits: hits(...OTHER.map((name): [string, number] => [name, 0.5])),
      recalls: [
        ["queue", TURN, "chat"],
        ["prefetch", "chat"],
      ],
    });
    expect(askedNames(clef.requests[0]?.body as ClefBody).sort()).toEqual(all);
    expect(recalledNames(out.recalls[0]?.block ?? "")).toEqual(ZEBRA);
  });

  test("an empty pool sends no Clef request and recalls nothing", async () => {
    const clef = stubClef({});
    const out = await run(await zebraSetup(), { cwd: gitRepo("my-repo") }, [], {
      env: { LLMOS_CLEF_URL: clef.url },
      recalls: [
        ["queue", "Completely unrelated question about weather patterns?", "chat"],
        ["prefetch", "chat"],
      ],
    });
    expect(clef.requests).toHaveLength(0);
    expect(out.recalls[0]).toEqual({ block: "", count: null });
    expect(clefLogs(out)).toEqual([]);
  });

  test("LLMOS_CLEF_MODEL names the model of the recall request", async () => {
    const clef = stubClef({ "alpha.md": 0.9 });
    await run(await zebraSetup(), { cwd: gitRepo("my-repo") }, [], {
      env: { LLMOS_CLEF_URL: clef.url, LLMOS_CLEF_MODEL: "other-decider" },
      recalls: [["queue", TURN, "chat"]],
    });
    expect(clef.requests.map((r) => r.body.model)).toEqual(["other-decider"]);
  });

  test("without a Clef URL, recall takes the first two semantic hits that score at least 0.75", async () => {
    const setupResult = await zebraSetup();
    const recall = async (searchHits: { path: string; score: number }[]) => {
      const out = await run(setupResult, { cwd: gitRepo("my-repo") }, [], {
        search_hits: searchHits,
        recalls: [
          ["queue", TURN, "chat"],
          ["prefetch", "chat"],
        ],
      });
      expect(clefLogs(out)).toEqual([]);
      return recalledNames(out.recalls[0]?.block ?? "");
    };
    // The word matches (the ZEBRA notes) are not recalled without Clef.
    expect(await recall(hits(["golf", 0.9], ["hotel", 0.8], ["india", 0.76]))).toEqual([
      "golf",
      "hotel",
    ]);
    expect(await recall(hits(["golf", 0.8], ["hotel", 0.74], ["india", 0.5]))).toEqual(["golf"]);
    expect(await recall(hits(["golf", 0.74]))).toEqual([]);
    expect(await recall(hits(["hotel", 0.8], ["golf", 0.8]))).toEqual(["hotel", "golf"]);
  });

  test.each<[string, (call: number) => ClefMode, Record<string, string>]>([
    ["is too slow", () => "slow", { LLMOS_CLEF_TIMEOUT: "0.3" }],
    ["sends its answer a byte at a time", () => "drip", { LLMOS_CLEF_TIMEOUT: "0.5" }],
    ["answers HTTP 500", () => "http500", {}],
    ["omits a field", () => "missing-field", {}],
    ["answers a non-numeric probability", () => "non-numeric", {}],
    ["answers too deeply nested JSON", () => "deep", {}],
    ["answers more than 1 MiB", () => "huge", {}],
  ])(
    "when Clef %s, recall falls back to the semantic hits and logs one warning",
    async (_name, mode, env) => {
      const clef = stubClef({ "bravo.md": 0.9 }, mode);
      const out = await run(await zebraSetup(), { cwd: gitRepo("my-repo") }, [], {
        env: { LLMOS_CLEF_URL: clef.url, ...env },
        search_hits: hits(["golf", 0.9]),
        recalls: [
          ["queue", TURN, "chat"],
          ["prefetch", "chat"],
        ],
      });
      expect(clef.requests).toHaveLength(1);
      // Clef would recall bravo; the fallback recalls golf.
      expect(recalledNames(out.recalls[0]?.block ?? "")).toEqual(["golf"]);
      expect(out.queue_seconds[0]).toBeLessThan(1.5);
      const logs = clefLogs(out);
      expect(logs.map(([level]) => level)).toEqual(["WARNING"]);
      expect(logs[0]?.[1]).toContain(clef.url);
      expect(logs[0]?.[1]).not.toContain("zebrafish");
    },
  );

  test("a failure logs a warning, the next consecutive ones debug, and a success resets it", async () => {
    const modes: ClefMode[] = ["http500", "http500", "ok", "http500"];
    const clef = stubClef({ "alpha.md": 0.9 }, (call) => modes[call - 1] ?? "ok");
    const out = await run(await zebraSetup(), { cwd: gitRepo("my-repo") }, [], {
      env: { LLMOS_CLEF_URL: clef.url },
      recalls: recallOnce(4),
    });
    expect(clefLogs(out).map(([level]) => level)).toEqual(["WARNING", "DEBUG", "WARNING"]);
  });

  test("a recall query fits the service's limit of 1000 JavaScript characters", async () => {
    // An emoji is two JavaScript (UTF-16) characters but one Python character.
    const out = await run(setup(), {}, [], { query: `${"\u{1F600}".repeat(900)}\nend` });
    expect(out.query.length).toBe(1000);
    expect(out.query).not.toContain("\n");
  });
});
