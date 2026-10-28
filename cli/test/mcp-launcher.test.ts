/**
 * The committed launcher `dist/mcp.js`, run as each harness runs it: the
 * installed CLI's server when there is one, else the `setup` tool. A
 * session's working directory is an untrusted project, so a run from a
 * hostile project must not load its `bunfig.toml` preload, its `.env`, or
 * its own `dist/mcp.js`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { SERVER_NAME } from "../src/mcp-names.ts";
import { CLI, isolatedEnv, makeVault, scratch, TOOLS, writeFiles } from "./helpers.ts";
import { McpClient } from "./mcp-client.ts";

const ALPHA = "---\nstatus: draft\n---\n\n# Alpha\n\nREALVAULT\n";

/** The server entry of a plugin MCP config file, with its command line. */
function declared(file: string): { argv: string[]; cwd?: string } {
  const servers = JSON.parse(readFileSync(join(TOOLS, file), "utf8")).mcpServers;
  const server = servers[SERVER_NAME] as { command: string; args: string[]; cwd?: string };
  return { argv: [server.command, ...server.args], cwd: server.cwd };
}

/** A home folder whose `~/.local/bin/llmos-vault` links to `entry` (none when null). */
function home(entry: string | null, vault?: string): Record<string, string> {
  const env = isolatedEnv();
  if (entry !== null) {
    mkdirSync(join(env.HOME as string, ".local", "bin"), { recursive: true });
    symlinkSync(entry, join(env.HOME as string, ".local", "bin", "llmos-vault"));
  }
  if (vault !== undefined) {
    writeFiles(env.HOME as string, {
      ".config/llmos/config.json": `${JSON.stringify({ vault_root: vault })}\n`,
    });
  }
  return env;
}

/** A project that would run code or swap the vault if Bun read its config. */
function hostileProject(): string {
  const project = scratch("project");
  const decoy = makeVault({ "notes/alpha.md": "# Alpha\n\nDECOY\n" });
  writeFiles(project, {
    "bunfig.toml": 'preload = ["./evil.ts"]\n',
    "evil.ts": `require("node:fs").writeFileSync(${JSON.stringify(join(project, "PRELOADED"))}, "x");\n`,
    ".env": `LLMOS_ROOT=${decoy}\n`,
    "dist/mcp.js": `require("node:fs").writeFileSync(${JSON.stringify(join(project, "PROJECT_LAUNCHER"))}, "x");\n`,
  });
  return project;
}

/** Start `argv` in `cwd` with `env` (plus PATH) and connect a client. */
async function start(argv: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(argv, {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = new McpClient((line) => {
    child.stdin.write(line);
  }, child.stdout);
  const init = await client.initialize("claude-code");
  return {
    client,
    init,
    close: async () => {
      child.stdin.end();
      return await child.exited;
    },
  };
}

/** The placeholder Claude Code substitutes in a plugin server's args. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder text.
const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";

/** Claude Code's command, with the plugin root substituted, run in the project. */
function claudeArgv(): string[] {
  return declared(".mcp.json").argv.map((arg) => arg.replace(PLUGIN_ROOT, TOOLS));
}

describe("the MCP launcher", () => {
  test("Claude Code's command runs the installed server, untouched by a hostile project", async () => {
    const vault = makeVault({ "notes/alpha.md": ALPHA });
    const project = hostileProject();
    const env = { ...home(join(CLI, "bin", "llmos-vault.ts"), vault), CLAUDE_PLUGIN_ROOT: TOOLS };
    const { client, init, close } = await start(claudeArgv(), project, env);
    expect((init.serverInfo as { name: string }).name).toBe(SERVER_NAME);
    const names = (await client.tools()).map((tool) => tool.name);
    expect(names).toContain("daily_append_thought");
    const read = await client.call("read", { note: "alpha" });
    expect(read.text).toContain("REALVAULT");
    expect(await close()).toBe(0);
    expect(existsSync(join(project, "PRELOADED"))).toBe(false);
    expect(existsSync(join(project, "PROJECT_LAUNCHER"))).toBe(false);
  });

  test("Codex's command runs from the plugin root it is given as cwd", async () => {
    const { argv, cwd } = declared(".codex-mcp.json");
    expect(cwd).toBe(".");
    const vault = makeVault({ "notes/alpha.md": ALPHA });
    // Codex joins the relative cwd to the plugin root and passes no CLAUDE_PLUGIN_ROOT.
    const { client, close } = await start(
      argv,
      TOOLS,
      home(join(CLI, "bin", "llmos-vault.ts"), vault),
    );
    expect((await client.call("read", { note: "alpha" })).text).toContain("REALVAULT");
    expect(await close()).toBe(0);
  });

  test("without an installed CLI, the only tool says to run setup-llmos", async () => {
    const { client, init, close } = await start(claudeArgv(), scratch("project"), {
      ...home(null),
      CLAUDE_PLUGIN_ROOT: TOOLS,
    });
    expect(init.instructions as string).toContain("setup-llmos");
    expect((await client.tools()).map((tool) => tool.name)).toEqual(["setup"]);
    const result = await client.call("setup", {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain("the llmOS CLI is not installed");
    expect(result.text).toContain("setup-llmos");
    expect(await close()).toBe(0);
  });

  test("an installed CLI from before the server also gets the setup tool", async () => {
    const old = scratch("install");
    writeFiles(old, { "bin/llmos-vault.ts": "console.log('old');\n" });
    const { client, close } = await start(claudeArgv(), scratch("project"), {
      ...home(join(old, "bin", "llmos-vault.ts")),
      CLAUDE_PLUGIN_ROOT: TOOLS,
    });
    const result = await client.call("setup", {});
    expect(result.text).toContain("predates the MCP server");
    expect(await close()).toBe(0);
  });

  test("both declarations start the launcher with the safe Bun flags and no shell", () => {
    for (const file of [".mcp.json", ".codex-mcp.json"]) {
      const { argv } = declared(file);
      expect(argv.slice(0, 4)).toEqual([
        "bun",
        "--no-install",
        "--no-env-file",
        "--config=/dev/null",
      ]);
      expect(argv).toHaveLength(5);
    }
    expect(declared(".mcp.json").argv[4]).toBe(`${PLUGIN_ROOT}/dist/mcp.js`);
    expect(declared(".codex-mcp.json").argv[4]).toBe("./dist/mcp.js");
  });
});
