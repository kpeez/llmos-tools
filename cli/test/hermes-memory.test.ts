/**
 * The Hermes memory provider (`hermes/memory_provider.py`), run by `python3`
 * with a stub of Hermes's `agent.memory_provider` module. It calls this
 * checkout's `llmos` CLI on a temporary vault, as Hermes would.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, makeVault, read, scratch, TOOLS } from "./helpers.ts";

const DRIVER = `
import importlib.util, json, sys
stub, provider_file = sys.argv[1], sys.argv[2]
sys.path.insert(0, stub)
spec = importlib.util.spec_from_file_location("llmos_memory_provider", provider_file)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.loads(sys.stdin.read())
provider = module.LlmosMemoryProvider()
provider.initialize("session", **request["init"])
out = {"available": provider.is_available(), "prompt": provider.system_prompt_block(),
       "tools": [schema["name"] for schema in provider.get_tool_schemas()], "calls": []}
for name, args in request["calls"]:
    out["calls"].append(json.loads(provider.handle_tool_call(name, args)))
print(json.dumps(out))
`;

const STUB = `
class MemoryProvider:
    pass
`;

interface Run {
  available: boolean;
  prompt: string;
  tools: string[];
  calls: Record<string, unknown>[];
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

function run(
  setupResult: ReturnType<typeof setup>,
  init: Record<string, unknown>,
  calls: [string, Record<string, unknown>][] = [],
): Run {
  const result = Bun.spawnSync({
    cmd: [
      python() as string,
      "-I",
      setupResult.driver,
      setupResult.stub,
      join(TOOLS, "hermes", "memory_provider.py"),
    ],
    stdin: Buffer.from(JSON.stringify({ init, calls })),
    env: setupResult.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString()) as Run;
}

function gitRepo(name: string): string {
  const repo = join(scratch("repo"), name);
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync({ cmd: ["git", "init", "--quiet", repo] });
  return repo;
}

describe.skipIf(python() === null)("Hermes memory provider", () => {
  test("a chat in a vault project's repository gets its index and saves there", () => {
    const setupResult = setup();
    const repo = gitRepo("my-repo");
    const out = run(setupResult, { cwd: repo, agent_context: "primary" }, [
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

  test("a chat with no folder uses personal memory", () => {
    const setupResult = setup();
    const out = run(setupResult, { agent_workspace: "hermes" }, [
      ["memory_save", { name: "tea", description: "Tea order", body: "Green tea.", type: "user" }],
    ]);
    expect(out.prompt).toContain("projects/personal/memory/ (project personal)");
    expect(existsSync(join(setupResult.root, "projects/personal/memory/tea.md"))).toBe(true);
  });

  test("a subagent or cron session reads memory but does not write it", () => {
    const setupResult = setup();
    const repo = gitRepo("my-repo");
    for (const agentContext of ["subagent", "cron", "flush"]) {
      const out = run(setupResult, { cwd: repo, agent_context: agentContext }, [
        ["memory_save", { name: "x", description: "d", body: "b", type: "project" }],
        ["memory_forget", { name: "old" }],
      ]);
      expect(out.prompt).toContain("- [Old](old.md)");
      expect(out.calls.every((call) => typeof call.error === "string")).toBe(true);
    }
    expect(existsSync(join(setupResult.root, "projects/my-repo/memory/x.md"))).toBe(false);
    expect(read(setupResult.root, "projects/my-repo/memory/MEMORY.md")).toContain("old.md");
  });

  test("a refused save returns the CLI's error as JSON", () => {
    const setupResult = setup();
    const out = run(setupResult, { cwd: gitRepo("my-repo") }, [
      ["memory_save", { name: "../escape", description: "d", body: "b", type: "project" }],
    ]);
    expect(String(out.calls[0]?.error)).toContain("name must be a lowercase slug");
  });
});
