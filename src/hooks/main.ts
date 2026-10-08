/**
 * Entry point of the bundled plugin hooks (`dist/hooks.js`).
 *
 * `hooks/hooks.json` runs `bun dist/hooks.js <event>` with the harness
 * payload on stdin. Each event keeps the output channel its harness reads:
 *
 * - `session-start`: plain stdout, which becomes session context. It then
 *   records a heartbeat for `llmos-doctor` (`src/heartbeat.ts`).
 * - `pre-tool-use`, `post-tool-use`: `hookSpecificOutput.additionalContext`
 *   JSON on stdout.
 * - `guard-bash`: exit code 2 with the reason on stderr denies the call.
 * - `stop`: diagnostics on stderr only.
 *
 * A hook failure never blocks the tool call: an error exits 0 without
 * output (the stop hook prints a diagnostic), and an unknown event does
 * nothing.
 */

import { isDict, readPayload } from "./common.ts";
import { preToolUse, sessionStart } from "./context.ts";
import { checkCommand } from "./guard.ts";
import { beat } from "./heartbeat.ts";
import { stop, warn } from "./stop.ts";

function emit(eventName: "PreToolUse" | "PostToolUse", context: string | null): void {
  if (!context) return;
  const output = { hookSpecificOutput: { hookEventName: eventName, additionalContext: context } };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function guardBash(): Promise<void> {
  const data = await readPayload();
  const command = isDict(data.tool_input) ? data.tool_input.command : undefined;
  if (typeof command !== "string" || !command) return;
  const message = checkCommand(command, data.cwd);
  if (message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}

async function run(event: string | undefined): Promise<void> {
  switch (event) {
    case "session-start": {
      const data = await readPayload();
      const context = sessionStart(data);
      if (context) process.stdout.write(`${context}\n`);
      // After the output, and never able to change it: `llmos-doctor` reads
      // this record to prove the hooks run for this agent.
      try {
        beat(data);
      } catch {}
      return;
    }
    case "pre-tool-use":
      emit("PreToolUse", preToolUse(await readPayload()));
      return;
    case "post-tool-use":
      // Loaded only here: the frontmatter and vault code costs startup time.
      emit("PostToolUse", await (await import("./stamp.ts")).postToolUse(await readPayload()));
      return;
    case "guard-bash":
      await guardBash();
      return;
    case "stop":
      try {
        stop(await readPayload());
      } catch (error) {
        warn(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    default:
      return;
  }
}

try {
  await run(process.argv[2]);
} catch {
  // A hook failure must never block the tool call.
}
