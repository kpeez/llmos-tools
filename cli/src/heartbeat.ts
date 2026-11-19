/**
 * The hook heartbeat: proof that the plugin hooks run for each agent.
 *
 * A hook that cannot start (no `bun` on the harness `PATH`) or that Codex
 * has not trusted fails without any message. So the session-start hook
 * records each successful run, and `llmos doctor` checks the record.
 *
 * The record is per-host state, so it lives in the XDG state folder:
 * `$XDG_STATE_HOME/llmos/hooks.json`, else `~/.local/state/llmos/hooks.json`.
 * This matches the other llmOS paths, which use the XDG layout on macOS too
 * (`~/.config/llmos/config.json` for config, `~/.cache/qmd` for the index,
 * `~/.local/share/llmos` for the CLI install). It is keyed by agent:
 *
 *   {"claude": {"time": "...", "bun": "1.4.2", "bundleSha256": "...", "pluginRoot": "..."}}
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type Env = Record<string, string | undefined>;

export interface Heartbeat {
  /** When the session-start hook last ran, as an ISO timestamp. */
  time: string;
  /** The Bun version that ran it. */
  bun: string;
  /** SHA-256 of the hook bundle that ran, to compare with the installed one. */
  bundleSha256: string;
  /** `$CLAUDE_PLUGIN_ROOT` of that run ("" when unset). */
  pluginRoot: string;
}

export type Heartbeats = Record<string, Heartbeat>;

/** Where the heartbeat lives for this environment. */
export function heartbeatPath(env: Env): string {
  const state = env.XDG_STATE_HOME;
  const base = state && isAbsolute(state) ? state : join(env.HOME || homedir(), ".local", "state");
  return join(base, "llmos", "hooks.json");
}

function isHeartbeat(value: unknown): value is Heartbeat {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return ["time", "bun", "bundleSha256", "pluginRoot"].every(
    (key) => typeof entry[key] === "string",
  );
}

/** Every well-formed entry of the heartbeat file; `{}` when it is missing or unreadable. */
export function readHeartbeats(env: Env): Heartbeats {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(heartbeatPath(env), "utf8"));
  } catch {
    return {};
  }
  const found: Heartbeats = {};
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    for (const [agent, entry] of Object.entries(data)) if (isHeartbeat(entry)) found[agent] = entry;
  }
  return found;
}

/** SHA-256 of a file, as lower-case hex. */
export function fileSha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Record `entry` for `agent`, keeping the other agents' entries. The file is
 * replaced through a temporary file and a rename, so a reader never sees a
 * partial write. Two sessions that start at the same moment can race; the
 * loser's entry comes back at its next session start.
 */
export function recordHeartbeat(agent: string, entry: Heartbeat, env: Env): void {
  const path = heartbeatPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const all = readHeartbeats(env);
  all[agent] = entry;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(temporary, path);
}
