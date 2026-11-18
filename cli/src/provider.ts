/**
 * Best-effort name of the agent harness that runs a command, from the
 * environment variables each harness sets. `CLAUDE_PLUGIN_ROOT` cannot be
 * used: Claude Code and Codex both set it.
 */

export const PROVIDER_ENV_MARKERS: readonly (readonly [string, string])[] = [
  ["claude", "CLAUDECODE"],
  ["codex", "CODEX_SANDBOX_NETWORK_DISABLED"],
  ["gemini", "ANTIGRAVITY_CLI"],
  ["gemini", "GEMINI_CLI"],
];

/** The provider whose marker is set and not empty, or null rather than a guess. */
export function detectProvider(env: Record<string, string | undefined>): string | null {
  for (const [name, marker] of PROVIDER_ENV_MARKERS) {
    if (env[marker]) return name;
  }
  return null;
}
