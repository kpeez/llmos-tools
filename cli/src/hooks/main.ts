/**
 * Entry point of the bundled plugin hooks (`dist/hooks.js`).
 *
 * `hooks/hooks.json` runs `bun dist/hooks.js <event>` with the harness
 * payload on stdin. Each event keeps the output channel its harness reads:
 *
 * - `session-start`: plain stdout, which becomes session context. In a cloud
 *   session it first pulls the vault and links each attached repository
 *   (`src/hooks/cloud.ts`); in a local session it first pulls the vault's
 *   shared project memory (`src/hooks/sync.ts`). In every session it links the project's agent
 *   folders (`src/hooks/links.ts`). It then records a heartbeat for
 *   `llmos doctor` (`src/heartbeat.ts`).
 * - `pre-tool-use`, `post-tool-use`: `hookSpecificOutput.additionalContext`
 *   JSON on stdout.
 * - `guard-bash`: exit code 2 with the reason on stderr denies the call.
 * - `stop`: diagnostics on stderr only. It reindexes, then commits and pushes
 *   changed shared project memory (`src/hooks/sync.ts`).
 *
 * A hook failure never blocks the tool call: an error exits 0 without
 * output (the stop hook prints a diagnostic), and an unknown event does
 * nothing.
 */

import { armHookDeadline } from "../hook-limits.ts";
import { cloudAttachHint, cloudSetup } from "./cloud.ts";
import {
  firstTruthy,
  isAntigravityPayload,
  pathFrom,
  payloadCwd,
  readPayload,
  resolvedRoot,
  toolInputOf,
  workspacePath,
} from "./common.ts";
import { preToolUse, sessionContext, sessionStart } from "./context.ts";
import { checkCommand } from "./guard.ts";
import { beat } from "./heartbeat.ts";
import { hasAutoMemoryDir, linkAgentDirs } from "./links.ts";
import { stop, warn } from "./stop.ts";
import { syncOnStart, syncOnStop } from "./sync.ts";

function emit(
  eventName: "PreToolUse" | "PostToolUse",
  context: string | null,
  antigravity: boolean,
): void {
  if (antigravity) {
    if (eventName === "PreToolUse") {
      const out = context ? { decision: "allow", reason: context } : { decision: "allow" };
      process.stdout.write(`${JSON.stringify(out)}\n`);
    } else {
      process.stdout.write("{}\n");
    }
    return;
  }
  if (!context) return;
  const output = { hookSpecificOutput: { hookEventName: eventName, additionalContext: context } };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function guardBash(): Promise<void> {
  const data = await readPayload();
  const antigravity = isAntigravityPayload(data);
  const toolInput = toolInputOf(data);
  const command = toolInput
    ? firstTruthy([toolInput.command, toolInput.CommandLine], undefined)
    : undefined;
  const cwd = firstTruthy([data.cwd, workspacePath(data)], undefined);
  const message = typeof command === "string" && command ? checkCommand(command, cwd) : null;
  if (antigravity) {
    const out = message ? { decision: "deny", reason: message } : { decision: "allow" };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}

async function run(event: string | undefined): Promise<void> {
  switch (event) {
    case "session-start": {
      const data = await readPayload();
      const antigravity = isAntigravityPayload(data);
      const root = resolvedRoot();
      const project = pathFrom(process.env.CLAUDE_PROJECT_DIR) ?? payloadCwd(data);
      const claudeAutoMemoryReady =
        root !== null && project !== null ? hasAutoMemoryDir(project, root) : false;
      // Before the context: the pull makes the injected MEMORY.md fresh, and the
      // links let sessionStart see the project.
      let syncNote: string | null = null;
      try {
        syncNote = root === null ? null : syncOnStart(root, process.env);
      } catch {}
      const cloud = root === null ? cloudAttachHint(process.env, Bun.main) : cloudSetup(root);
      const linked = root && project ? linkAgentDirs(project, root).join("\n") : null;
      // A cloud session's working folder holds several repositories, so the
      // vault context applies even when the cwd itself is not linked.
      // Hermes's llmos memory provider puts the index in the system prompt itself.
      const memoryIndexLoaded = process.env.LLMOS_MEMORY_INDEX_LOADED === "1";
      const options = { claudeAutoMemoryReady, memoryIndexLoaded };
      const vault =
        sessionStart(data, options) ??
        (cloud && root ? sessionContext(root, null, { data, ...options, cwd: project }) : null);
      const context = [vault, cloud, syncNote, linked].filter(Boolean).join("\n");
      if (antigravity) {
        const out = context ? { injectSteps: [{ systemMessage: { systemMessage: context } }] } : {};
        process.stdout.write(`${JSON.stringify(out)}\n`);
      } else if (context) {
        process.stdout.write(`${context}\n`);
      }
      // After the output, and never able to change it: `llmos doctor` reads
      // this record to prove the hooks run for this agent.
      try {
        beat(data);
      } catch {}
      return;
    }
    case "pre-tool-use": {
      const data = await readPayload();
      emit("PreToolUse", preToolUse(data), isAntigravityPayload(data));
      return;
    }
    case "post-tool-use": {
      const data = await readPayload();
      // Loaded only here: the frontmatter and vault code costs startup time.
      const context = await (await import("./stamp.ts")).postToolUse(data);
      emit("PostToolUse", context, isAntigravityPayload(data));
      return;
    }
    case "guard-bash":
      await guardBash();
      return;
    case "stop": {
      const data = await readPayload();
      try {
        stop();
      } catch (error) {
        warn(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const root = resolvedRoot();
        if (root !== null) syncOnStop(root, process.env);
      } catch (error) {
        warn(`sync failure: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (isAntigravityPayload(data)) process.stdout.write("{}\n");
      return;
    }
    default:
      return;
  }
}

try {
  armHookDeadline(process.argv[2]);
  await run(process.argv[2]);
} catch {
  // A hook failure must never block the tool call.
}
