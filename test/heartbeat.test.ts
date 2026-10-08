/**
 * The hook heartbeat: `llmos-doctor` passes, warns, and fails on it the way
 * setup-llmos describes, with every path (HOME, XDG_STATE_HOME, the agents'
 * install records) in a temporary folder.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookChecks } from "../src/doctor.ts";
import { fileSha256, heartbeatPath, readHeartbeats, recordHeartbeat } from "../src/heartbeat.ts";
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
  const claudeRoot = join(home, ".claude", "plugins", "cache", "llmos-vault", "llmos", "1.3.0");
  const codexCache = join(home, ".codex", "plugins", "cache", "llmos-vault", "llmos");
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
        plugins: { "llmos@llmos-vault": [{ scope: "user", installPath: claudeRoot }] },
      }),
    );
  }
  if (options.codex !== false) {
    const enabled = options.codex === "disabled" ? "false" : "true";
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `[plugins."other@x"]\nenabled = true\n\n[plugins."llmos@llmos-vault"]\nenabled = ${enabled}\n\n[hooks.state."x"]\ntrusted_hash = "y"\n`,
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

describe("llmos-doctor hook checks", () => {
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
        plugins: { "llmos@llmos-vault": [{ installPath: join(h.env.HOME, "old-plugin") }] },
      }),
    );

    const { lines, failures } = hookChecks(h.env, NOW);

    expect(failures).toBe(1);
    expect(lines.join("\n")).toContain("has no dist/hooks.js");
    expect(lines.join("\n")).toContain("claude plugin update llmos@llmos-vault");
  });

  test("skip an agent without the plugin, and fail when neither has it", () => {
    const claudeOnly = host({ codex: "disabled" });
    beatFor(claudeOnly, "claude", claudeOnly.claudeBundle);
    const one = hookChecks(claudeOnly.env, NOW);
    expect(one.failures).toBe(0);
    expect(one.lines.join("\n")).toContain(
      "NOTE hooks-codex: the llmos@llmos-vault plugin is not installed",
    );

    const none = hookChecks(host({ claude: false, codex: false }).env, NOW);
    expect(none.failures).toBe(1);
    expect(none.lines.join("\n")).toContain(
      "FAIL hooks: the llmos@llmos-vault plugin is installed for neither",
    );
  });
});
