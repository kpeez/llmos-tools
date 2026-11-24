/**
 * The hook heartbeat: `llmos doctor` passes, warns, and fails on it the way
 * setup-llmos describes, with every path (HOME, XDG_STATE_HOME, the agents'
 * install records) in a temporary folder.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hermesProfileChecks, hookChecks } from "../src/doctor.ts";
import { fileSha256, heartbeatPath, readHeartbeats, recordHeartbeat } from "../src/heartbeat.ts";
import { hookAgent } from "../src/hooks/heartbeat.ts";
import { scratch } from "./helpers.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 86_400_000;

interface Host {
  env: { HOME: string; XDG_STATE_HOME: string };
  claudeBundle: string;
  codexBundle: string;
}

/** A host with the plugin installed for Claude and Codex (each with a bundle), no heartbeat. */
function host(options: { claude?: boolean; codex?: boolean | "disabled" } = {}): Host {
  const home = scratch("heartbeat-home");
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state") };
  const claudeRoot = join(home, ".claude", "plugins", "cache", "llmos-tools", "llmos", "1.3.0");
  const codexCache = join(home, ".codex", "plugins", "cache", "llmos-tools", "llmos");
  for (const [root, text] of [
    [claudeRoot, "claude bundle"],
    [join(codexCache, "1.2.0"), "old codex bundle"],
    [join(codexCache, "1.10.0"), "codex bundle"],
  ] as const) {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "hooks.js"), text);
  }
  if (options.claude !== false) {
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "llmos@llmos-tools": [{ scope: "user", installPath: claudeRoot }] },
      }),
    );
  }
  if (options.codex !== false) {
    const enabled = options.codex === "disabled" ? "false" : "true";
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `[plugins."other@x"]\nenabled = true\n\n[plugins."llmos@llmos-tools"]\nenabled = ${enabled}\n\n[hooks.state."x"]\ntrusted_hash = "y"\n`,
    );
  }
  return {
    env,
    claudeBundle: join(claudeRoot, "dist", "hooks.js"),
    codexBundle: join(codexCache, "1.10.0", "dist", "hooks.js"),
  };
}

function beatFor(host: Host, agent: string, bundle: string, age = 0): void {
  recordHeartbeat(
    agent,
    {
      time: new Date(NOW - age).toISOString(),
      bun: "1.4.2",
      bundleSha256: fileSha256(bundle),
      pluginRoot: join(bundle, "..", ".."),
    },
    host.env,
  );
}

describe("heartbeat record", () => {
  test("lives under XDG_STATE_HOME, else ~/.local/state, and keeps other agents' entries", () => {
    expect(heartbeatPath({ HOME: "/h", XDG_STATE_HOME: "/s" })).toBe("/s/llmos/hooks.json");
    expect(heartbeatPath({ HOME: "/h" })).toBe("/h/.local/state/llmos/hooks.json");
    expect(heartbeatPath({ HOME: "/h", XDG_STATE_HOME: "relative" })).toBe(
      "/h/.local/state/llmos/hooks.json",
    );
    const h = host();
    beatFor(h, "claude", h.claudeBundle);
    beatFor(h, "codex", h.codexBundle);
    expect(Object.keys(readHeartbeats(h.env)).sort()).toEqual(["claude", "codex"]);
  });
});

describe("llmos doctor hook checks", () => {
  test("pass when each installed agent's hooks ran the installed bundle", () => {
    const h = host();
    beatFor(h, "claude", h.claudeBundle, DAY);
    beatFor(h, "codex", h.codexBundle, 6 * DAY);

    const { lines, failures } = hookChecks(h.env, NOW);

    expect(failures).toBe(0);
    expect(lines.filter((line) => line.startsWith("PASS"))).toHaveLength(2);
    expect(lines.join("\n")).toContain("PASS hooks-codex: hooks ran");
  });

  test("warn when the last heartbeat is older than 7 days", () => {
    const h = host();
    beatFor(h, "claude", h.claudeBundle, 8 * DAY);
    beatFor(h, "codex", h.codexBundle);

    const { lines, failures } = hookChecks(h.env, NOW);

    expect(failures).toBe(0);
    expect(lines.join("\n")).toContain("WARN hooks-claude:");
    expect(lines.join("\n")).toContain("8 days ago");
  });

  test("warn about an unreadable heartbeat time instead of printing NaN days", () => {
    const h = host();
    beatFor(h, "claude", h.claudeBundle);
    beatFor(h, "codex", h.codexBundle);
    recordHeartbeat(
      "claude",
      {
        time: "last tuesday",
        bun: "1.4.2",
        bundleSha256: fileSha256(h.claudeBundle),
        pluginRoot: "",
      },
      h.env,
    );

    const { lines, failures } = hookChecks(h.env, NOW);

    expect(failures).toBe(0);
    expect(lines.join("\n")).toContain(
      'WARN hooks-claude: the heartbeat has an unreadable time ("last tuesday")',
    );
    expect(lines.join("\n")).not.toContain("NaN");
  });

  test("fail with the agent's repair when an installed agent has no heartbeat", () => {
    const h = host();
    beatFor(h, "claude", h.claudeBundle);

    const { lines, failures } = hookChecks(h.env, NOW);

    expect(failures).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("FAIL hooks-codex: no heartbeat");
    expect(text).toContain("approve the llmOS hooks");
    expect(text).toContain("bun");
  });

  test("fail when the heartbeat ran another bundle than the installed one", () => {
    const h = host();
    beatFor(h, "claude", h.claudeBundle);
    beatFor(h, "codex", h.codexBundle);
    writeFileSync(h.claudeBundle, "updated claude bundle");

    const { lines, failures } = hookChecks(h.env, NOW);

    expect(failures).toBe(1);
    expect(lines.join("\n")).toContain("FAIL hooks-claude: the last heartbeat");
    expect(lines.join("\n")).toContain("put bun on the PATH Claude Code gives hooks");
  });

  test("fail when the installed plugin predates the Bun hooks", () => {
    const h = host({ codex: false });
    writeFileSync(
      join(h.env.HOME, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "llmos@llmos-tools": [{ installPath: join(h.env.HOME, "old-plugin") }] },
      }),
    );

    const { lines, failures } = hookChecks(h.env, NOW);

    expect(failures).toBe(1);
    expect(lines.join("\n")).toContain("has no dist/hooks.js");
    expect(lines.join("\n")).toContain("claude plugin update llmos@llmos-tools");
  });

  test("skip an agent without the plugin, and fail when neither has it", () => {
    const claudeOnly = host({ codex: "disabled" });
    beatFor(claudeOnly, "claude", claudeOnly.claudeBundle);
    const one = hookChecks(claudeOnly.env, NOW);
    expect(one.failures).toBe(0);
    expect(one.lines.join("\n")).toContain(
      "NOTE hooks-codex: the llmos@llmos-tools plugin is not installed",
    );

    const none = hookChecks(host({ claude: false, codex: false }).env, NOW);
    expect(none.failures).toBe(1);
    expect(none.lines.join("\n")).toContain(
      "FAIL hooks: the llmos@llmos-tools plugin is installed for neither",
    );
  });

  test("find a plugin from the account sync, and fail when no bucket lists llmos", () => {
    const h = host({ claude: false, codex: false });
    const bucket = join(h.env.HOME, ".claude", "plugins", "synced", "bucket-1");
    const synced = (name: string, plugin: string, marketplaceName: string) => {
      mkdirSync(join(bucket, name, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(bucket, name, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: plugin }),
      );
      return { pluginId: `plugin_${name}`, name, version: "0001", marketplaceName };
    };
    const other = synced("other", "other", "other-market");
    const foreign = synced("not-llmos", "not-llmos", "llmos-tools");
    writeFileSync(
      join(bucket, "manifest.json"),
      JSON.stringify({ lastUpdated: 1, plugins: [other, foreign] }),
    );

    const absent = hookChecks(h.env, NOW);
    expect(absent.failures).toBe(1);
    expect(absent.lines.join("\n")).toContain("FAIL hooks: the llmos@llmos-tools plugin");

    const uuid = synced("0b5e-uuid-folder", "llmos", "llmos-tools");
    writeFileSync(
      join(bucket, "manifest.json"),
      JSON.stringify({ lastUpdated: 2, plugins: [other, foreign, uuid] }),
    );
    const bundle = join(bucket, uuid.name, "dist", "hooks.js");
    mkdirSync(join(bucket, uuid.name, "dist"), { recursive: true });
    writeFileSync(bundle, "synced bundle");
    beatFor(h, "claude", bundle);

    const found = hookChecks(h.env, NOW);
    expect(found.failures).toBe(0);
    expect(found.lines.join("\n")).toContain("PASS hooks-claude: hooks ran");
  });

  test("checks hooks-agy when ~/.gemini/config/plugins/llmos is installed", () => {
    const h = host({ claude: false, codex: false });
    const plugin = join(h.env.HOME, ".gemini", "config", "plugins", "llmos");
    mkdirSync(join(plugin, "dist"), { recursive: true });
    writeFileSync(join(plugin, "dist", "hooks.js"), "agy bundle");

    const missing = hookChecks(h.env, NOW);
    expect(missing.failures).toBe(1);
    expect(missing.lines.join("\n")).toContain("FAIL hooks-agy: no heartbeat");

    beatFor(h, "agy", join(plugin, "dist", "hooks.js"));
    const passing = hookChecks(h.env, NOW);
    expect(passing.failures).toBe(0);
    expect(passing.lines.join("\n")).toContain("PASS hooks-agy: hooks ran");

    writeFileSync(
      join(h.env.HOME, ".gemini", "config", "config.json"),
      JSON.stringify({ plugins: { llmos: { enabled: false } } }),
    );
    const disabled = hookChecks(h.env, NOW);
    expect(disabled.failures).toBe(1);
    expect(disabled.lines.join("\n")).toContain("NOTE hooks-agy:");
  });

  test("checks hooks-hermes against the bundle above the linked hermes/ folder", () => {
    const h = host({ claude: false, codex: false });
    const tools = join(h.env.HOME, "llmos-tools");
    mkdirSync(join(tools, "hermes"), { recursive: true });
    mkdirSync(join(tools, "dist"), { recursive: true });
    writeFileSync(join(tools, "dist", "hooks.js"), "hermes bundle");
    mkdirSync(join(h.env.HOME, ".hermes", "plugins"), { recursive: true });
    symlinkSync(join(tools, "hermes"), join(h.env.HOME, ".hermes", "plugins", "llmos"));

    const missing = hookChecks(h.env, NOW);
    expect(missing.failures).toBe(1);
    expect(missing.lines.join("\n")).toContain("FAIL hooks-hermes: no heartbeat");

    beatFor(h, "hermes", join(tools, "dist", "hooks.js"));
    const passing = hookChecks(h.env, NOW);
    expect(passing.failures).toBe(0);
    expect(passing.lines.join("\n")).toContain("PASS hooks-hermes: hooks ran");
  });

  test("checks hooks-opencode against the bundle of the installed plugin the adapter runs", () => {
    const h = host({ claude: false, codex: false });
    const installed = join(h.env.HOME, ".local", "share", "llmos", "current");
    mkdirSync(join(installed, "dist"), { recursive: true });
    writeFileSync(join(installed, "dist", "hooks.js"), "opencode bundle");
    expect(hookChecks(h.env, NOW).lines.join("\n")).toContain("NOTE hooks-opencode:");

    mkdirSync(join(h.env.HOME, ".config", "opencode", "plugins"), { recursive: true });
    writeFileSync(join(h.env.HOME, ".config", "opencode", "plugins", "llmos.ts"), "");
    const missing = hookChecks(h.env, NOW);
    expect(missing.failures).toBe(1);
    expect(missing.lines.join("\n")).toContain("FAIL hooks-opencode: no heartbeat");

    beatFor(h, "opencode", join(installed, "dist", "hooks.js"));
    const passing = hookChecks(h.env, NOW);
    expect(passing.failures).toBe(0);
    expect(passing.lines.join("\n")).toContain("PASS hooks-opencode: hooks ran");
  });

  test("fails hooks-hermes when the plugin link points at a missing folder", () => {
    const h = host({ claude: false, codex: false });
    mkdirSync(join(h.env.HOME, ".hermes", "plugins"), { recursive: true });
    symlinkSync(
      join(h.env.HOME, "moved", "hermes"),
      join(h.env.HOME, ".hermes", "plugins", "llmos"),
    );

    const result = hookChecks(h.env, NOW);
    expect(result.failures).toBe(1);
    expect(result.lines.join("\n")).toContain("FAIL hooks-hermes:");
  });
});

describe("hookAgent", () => {
  test("names the agent from the plugin root the OpenCode adapter sets", () => {
    expect(hookAgent({ PLUGIN_ROOT: "/Users/k/.config/opencode/plugins/llmos" }, {})).toBe(
      "opencode",
    );
  });

  test("names the agent from the plugin root the Hermes adapter sets", () => {
    expect(hookAgent({ PLUGIN_ROOT: "/Users/k/.hermes/plugins/llmos" }, {})).toBe("hermes");
    expect(hookAgent({ CLAUDE_PLUGIN_ROOT: "/Users/k/.claude/plugins/cache/x" }, {})).toBe(
      "claude",
    );
  });
});

describe("hermesProfileChecks", () => {
  /** A Hermes profile home; `wired` adds every piece llmos needs, linked into `tools`. */
  function profile(home: string, tools: string, wired: boolean): void {
    const skills = join(tools, "skills");
    mkdirSync(join(home, "plugins"), { recursive: true });
    const config = wired
      ? `mcp_servers:\n  llmos:\n    command: llmos\n    tools:\n      exclude: ["memory_*"]\nmemory:\n  provider: llmos\nskills:\n  external_dirs:\n    - ${skills}\nplugins:\n  enabled:\n    - llmos\n`
      : "mcp_servers:\n  atuin:\n    command: atuin\n";
    writeFileSync(join(home, "config.yaml"), config);
    writeFileSync(
      join(home, "SOUL.md"),
      wired ? "The llmOS vault is the source of truth." : "Be direct.",
    );
    if (wired) symlinkSync(join(tools, "hermes"), join(home, "plugins", "llmos"));
  }

  /** A fake llmos tree: the skills folder and the adapter. */
  function tree(root: string): string {
    mkdirSync(join(root, "skills", "maintain-llmos"), { recursive: true });
    writeFileSync(join(root, "skills", "maintain-llmos", "SKILL.md"), "skill");
    mkdirSync(join(root, "hermes"), { recursive: true });
    writeFileSync(join(root, "hermes", "__init__.py"), "");
    return root;
  }

  test("checks every profile once any profile links the plugin", () => {
    const home = scratch("hermes-profiles");
    const installed = tree(join(home, ".local", "share", "llmos", "1.0.0"));
    symlinkSync(installed, join(home, ".local", "share", "llmos", "current"));
    const current = join(home, ".local", "share", "llmos", "current");
    const env = { HOME: home };

    expect(hermesProfileChecks(env)).toEqual({ lines: [], failures: 0 });

    profile(join(home, ".hermes"), installed, true);
    profile(join(home, ".hermes", "profiles", "coder"), current, true);
    profile(join(home, ".hermes", "profiles", "later"), installed, false);
    const tilde = join(home, ".hermes", "profiles", "tilde");
    profile(tilde, installed, true);
    const tildeConfig = join(tilde, "config.yaml");
    writeFileSync(
      tildeConfig,
      readFileSync(tildeConfig, "utf8").replace(
        /external_dirs:\n {4}- .*\n/,
        "external_dirs: ~/.local/share/llmos/current/skills\n",
      ),
    );
    const result = hermesProfileChecks(env);
    expect(result.failures).toBe(1);
    const text = result.lines.join("\n");
    expect(text).toContain("PASS hermes-profile-default");
    expect(text).toContain("PASS hermes-profile-coder");
    expect(text).toContain("PASS hermes-profile-tilde");
    expect(text).toContain("FAIL hermes-profile-later");
    for (const gap of [
      "mcp_servers.llmos",
      "memory.provider: llmos",
      "skills.external_dirs",
      "plugins.enabled",
      "plugins/llmos",
      "SOUL.md",
    ]) {
      expect(text).toContain(gap);
    }
  });

  test("fails a profile that shows Hermes the MCP server's memory tools", () => {
    const home = scratch("hermes-memory-tools");
    const installed = tree(join(home, ".local", "share", "llmos", "1.0.0"));
    const config = join(home, ".hermes", "config.yaml");
    profile(join(home, ".hermes"), installed, true);
    const wired = readFileSync(config, "utf8");
    const withTools = (tools: string) =>
      wired.replace('    tools:\n      exclude: ["memory_*"]\n', tools);
    const check = () => hermesProfileChecks({ HOME: home }).lines.join("\n");

    for (const hidden of [
      '    tools:\n      exclude: ["memory_save", "memory_search", "memory_forget"]\n',
      '    tools:\n      include: ["read", "search"]\n',
      '    tools:\n      include: ["read"]\n      exclude: []\n',
    ]) {
      writeFileSync(config, withTools(hidden));
      expect(check()).toContain("PASS hermes-profile-default");
    }
    for (const shown of [
      "",
      '    tools:\n      exclude: ["memory_save"]\n',
      '    tools:\n      include: ["read", "memory_*"]\n      exclude: ["memory_*"]\n',
    ]) {
      writeFileSync(config, withTools(shown));
      expect(check()).toContain('mcp_servers.llmos.tools.exclude: ["memory_*"]');
    }
    writeFileSync(config, wired.replace("memory:\n  provider: llmos\n", ""));
    expect(check()).toContain("memory.provider: llmos");
  });

  test("fails a profile whose plugin link and skills folder are in a checkout", () => {
    const home = scratch("hermes-checkout");
    tree(join(home, ".local", "share", "llmos", "1.0.0"));
    const checkout = tree(join(home, "code", "llmos-tools"));
    profile(join(home, ".hermes"), checkout, true);

    const result = hermesProfileChecks({ HOME: home });
    expect(result.failures).toBe(1);
    const text = result.lines.join("\n");
    expect(text).toContain("FAIL hermes-profile-default");
    expect(text).toContain("link it to ~/.local/share/llmos/current/hermes");
    expect(text).toContain("set it to ~/.local/share/llmos/current/skills");
  });

  test("checks the profiles when the only plugin link points at a missing folder", () => {
    const home = scratch("hermes-dangling");
    mkdirSync(join(home, ".hermes", "plugins"), { recursive: true });
    writeFileSync(join(home, ".hermes", "config.yaml"), "mcp_servers: {}\n");
    symlinkSync(join(home, "moved", "hermes"), join(home, ".hermes", "plugins", "llmos"));

    const result = hermesProfileChecks({ HOME: home });
    expect(result.failures).toBe(1);
    expect(result.lines.join("\n")).toContain("FAIL hermes-profile-default");
    expect(result.lines.join("\n")).toContain("plugins/llmos");
  });
});
