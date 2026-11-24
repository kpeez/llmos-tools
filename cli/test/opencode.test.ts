/**
 * The OpenCode adapter (`opencode/llmos.ts`) driven the way OpenCode 2 drives a
 * plugin: `setup(ctx)` registers hooks, and each hook gets the event shapes
 * recorded from a real `opencode run` (v2.4.1). The adapter runs the committed
 * bundles against a temporary vault, never the machine's.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import { isolatedEnv, makeVault, read } from "./helpers.ts";

type Hook = (event: Record<string, unknown>) => Promise<void>;

const TOOLS = join(import.meta.dir, "..", "..");
const SESSION = "ses_test";
const ROOT_SESSION = "ses_vault_root";
const OUTSIDE_SESSION = "ses_outside";
const NOTE = "---\ncreated: 2026-07-01\n---\n# A note\n\nBody.\n";

let vault: string;
let folder: string;
const hooks = new Map<string, Hook>();
const saved = { ...process.env };

beforeAll(async () => {
  vault = makeVault({ "notes/n.md": NOTE, "notes/alpha.md": NOTE });
  folder = join(vault, "notes");
  Object.assign(process.env, isolatedEnv({ LLMOS_ROOT: vault, LLMOS_PLUGIN_ROOT: TOOLS }), {
    HOME: dirname(vault),
  });
  const adapter = (await import("../../opencode/llmos.ts")).default;
  const ctx = {
    location: { directory: folder },
    session: {
      hook: (name: string, fn: Hook) => hooks.set(`session.${name}`, fn),
      get: async ({ sessionID }: { sessionID: string }) => ({
        directory:
          sessionID === ROOT_SESSION
            ? vault
            : sessionID === OUTSIDE_SESSION
              ? process.cwd()
              : folder,
      }),
    },
    tool: { hook: (name: string, fn: Hook) => hooks.set(`tool.${name}`, fn) },
    event: { subscribe: () => (async function* () {})() },
  };
  adapter.setup(ctx as never);
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const before = (tool: string, input: Record<string, unknown>) =>
  hooks.get("tool.execute.before")?.({ tool, id: `call_${tool}`, sessionID: SESSION, input });

describe("the vault guard in OpenCode", () => {
  test.each([
    ["rm of a note by relative path", "rm n.md"],
    ["rm of a note after another command", "ls && rm n.md"],
    ["mv of a note", "mv n.md moved.md"],
  ])("denies %s on the shell tool", async (_name, command) => {
    await expect(before("shell", { command })).rejects.toThrow(/orphans any wikilinks/);
  });

  test("denies a relative rm run in another folder through workdir", async () => {
    await expect(before("shell", { command: "rm notes/n.md", workdir: vault })).rejects.toThrow(
      /orphans any wikilinks/,
    );
  });

  test("denies rm through a relative workdir, with the bundle running outside the vault", async () => {
    expect(process.cwd().startsWith(vault)).toBe(false);
    await expect(
      hooks.get("tool.execute.before")?.({
        tool: "shell",
        id: "call_relative",
        sessionID: ROOT_SESSION,
        input: { command: "rm alpha.md", workdir: "notes" },
      }),
    ).rejects.toThrow(/orphans any wikilinks/);
  });

  test("denies rm through a workdir that starts with ~", async () => {
    await expect(
      hooks.get("tool.execute.before")?.({
        tool: "shell",
        id: "call_home",
        sessionID: OUTSIDE_SESSION,
        input: { command: "rm alpha.md", workdir: `~/${basename(vault)}/notes` },
      }),
    ).rejects.toThrow(/orphans any wikilinks/);
  });

  test.each([
    ["a command that touches no note", "ls"],
    ["rm of a file that is not a note", "rm scratch.txt"],
  ])("allows %s", async (_name, command) => {
    await expect(before("shell", { command })).resolves.toBeUndefined();
  });
});

describe("the vault hooks in OpenCode", () => {
  test("the session context carries the vault guidance, once per session", async () => {
    const system: unknown[] = [];
    await hooks.get("session.context")?.({ sessionID: SESSION, system });
    expect(JSON.stringify(system)).toContain("llmOS");
    const again: unknown[] = [];
    await hooks.get("session.context")?.({ sessionID: SESSION, system: again });
    expect(again).toEqual(system);
  });

  test("a write to a vault note is stamped and its result carries the authoring contract", async () => {
    const path = join(folder, "n.md");
    const input = { path, content: NOTE };
    await before("write", input);
    const event = {
      tool: "write",
      id: "call_write",
      sessionID: SESSION,
      input,
      status: "completed",
      result: { content: [{ type: "text", text: "Created file" }] },
    };
    await hooks.get("tool.execute.after")?.(event);
    expect(read(vault, "notes/n.md")).toMatch(/updated:/);
    const content = (event.result as { content: { text: string }[] }).content;
    expect(content.at(-1)?.text).toStartWith("[llmOS vault]");
  });
});
