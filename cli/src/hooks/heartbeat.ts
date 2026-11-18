/**
 * The session-start hook's heartbeat (see `src/heartbeat.ts`): which agent
 * ran the hooks, when, with which Bun, and which bundle.
 */

import { type Env, fileSha256, recordHeartbeat } from "../heartbeat.ts";
import { detectProvider } from "../provider.ts";
import { isAntigravityPayload, type Payload } from "./common.ts";

/**
 * The agent running this hook. The plugin root comes first: each agent
 * installs plugins under its own folder (`~/.claude/plugins`,
 * `~/.codex/plugins`, `~/.gemini/config/plugins`), and it cannot be inherited
 * by a nested agent the way environment markers can (a Codex started from a
 * Claude shell still has `CLAUDECODE`). Then the environment markers, then
 * the transcript path.
 */
export function hookAgent(env: Env, data: Payload): string {
  const root = env.PLUGIN_ROOT ?? env.CLAUDE_PLUGIN_ROOT ?? "";
  if (root.includes("/.codex/")) return "codex";
  if (root.includes("/.gemini/")) return "agy";
  if (root.includes("/.claude/")) return "claude";
  if (env.ANTIGRAVITY_CLI) return "agy";
  const marked = detectProvider(env);
  if (marked) return marked;
  const transcript =
    typeof data.transcript_path === "string"
      ? data.transcript_path
      : typeof data.transcriptPath === "string"
        ? data.transcriptPath
        : "";
  if (transcript.includes("/.codex/")) return "codex";
  if (transcript.includes("/.gemini/")) return "agy";
  if (transcript.includes("/.claude/")) return "claude";
  if (isAntigravityPayload(data, env)) return "agy";
  return "unknown";
}

/** Record this run. Best effort: the caller ignores any error. */
export function beat(data: Payload, env: Env = process.env, bundle = process.argv[1] ?? ""): void {
  recordHeartbeat(
    hookAgent(env, data),
    {
      time: new Date().toISOString(),
      bun: Bun.version,
      bundleSha256: fileSha256(bundle),
      pluginRoot: env.PLUGIN_ROOT ?? env.CLAUDE_PLUGIN_ROOT ?? "",
    },
    env,
  );
}
