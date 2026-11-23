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

import { cloudAttachHint, cloudSetup } from "./cloud.ts";
import {
  firstTruthy,
  isAntigravityPayload,
  type Payload,
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

type HookResult =
  | { event: "session-start"; context: string | null }
  | { event: "pre-tool-use"; context: string | null }
  | { event: "post-tool-use"; context: string | null }
  | { event: "guard-bash"; denial: string | null }
  | { event: "stop" };

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function additionalContext(eventName: "PreToolUse" | "PostToolUse", context: string | null): void {
  if (!context) return;
  writeJson({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } });
}

/**
 * The only writer of a hook's output channels. Each event keeps the envelope
 * its harness reads; the lint in `cli/lint/hook-channels.grit` bans
 * `process.stdout` elsewhere in the hooks.
 */
function emit(result: HookResult, antigravity: boolean): void {
  switch (result.event) {
    case "session-start":
      if (antigravity) {
        writeJson(
          result.context
            ? { injectSteps: [{ systemMessage: { systemMessage: result.context } }] }
            : {},
        );
      } else if (result.context) {
        process.stdout.write(`${result.context}\n`);
      }
      return;
    case "pre-tool-use":
      if (antigravity) {
        writeJson(
          result.context ? { decision: "allow", reason: result.context } : { decision: "allow" },
        );
      } else {
        additionalContext("PreToolUse", result.context);
      }
      return;
    case "post-tool-use":
      if (antigravity) writeJson({});
      else additionalContext("PostToolUse", result.context);
      return;
    case "guard-bash":
      if (antigravity) {
        writeJson(
          result.denial ? { decision: "deny", reason: result.denial } : { decision: "allow" },
        );
      } else if (result.denial) {
        process.stderr.write(`${result.denial}\n`);
        process.exitCode = 2;
      }
      return;
    case "stop":
      if (antigravity) writeJson({});
      return;
    default:
      result satisfies never;
  }
}

/**
 * The payload with `cwd` resolved, as a hook has always read it: a relative
 * `cwd` or `workspacePaths[0]` is anchored at the hook process's folder. A
 * payload that names no folder gets one only for the events that always had
 * one; a session start without one reads no project. The guard reads the raw
 * payload (see `guardFolders`). Only this file reads
 * `process.cwd()`; the handlers take their scope from the payload.
 */
async function readSessionPayload(event: HookResult["event"]): Promise<Payload> {
  const data = await readPayload();
  const here = process.cwd();
  const named = pathFrom(data.cwd, here) ?? pathFrom(workspacePath(data), here);
  if (event === "guard-bash") return data;
  if (named !== null) return { ...data, cwd: named };
  return event === "session-start" ? data : { ...data, cwd: here };
}

/**
 * Every folder the guard checks a command from, so it is never weaker than
 * any reading of the payload: the folder as written (a relative or odd value
 * under the process folder, as hooks first read it) and the folder resolved
 * (`~` expanded, a blank value dropped, the process folder when none is named).
 */
function guardFolders(data: Payload): (string | null)[] {
  const here = process.cwd();
  const raw = firstTruthy([data.cwd, workspacePath(data)], undefined);
  const folders: (string | null)[] = [];
  if (typeof raw === "string") folders.push(raw.startsWith("/") ? raw : `${here}/${raw}`);
  folders.push(pathFrom(data.cwd, here) ?? pathFrom(workspacePath(data), here) ?? here);
  return [...new Set(folders)];
}

function firstDenial(command: string, folders: (string | null)[]): string | null {
  for (const folder of folders) {
    const message = checkCommand(command, folder, process.cwd());
    if (message) return message;
  }
  return null;
}

type ResultOf<E extends HookResult["event"]> = Extract<HookResult, { event: E }>;

/**
 * One handler per event, each typed to return its own event's result, so a
 * handler cannot return the result of another event.
 */
const handlers: {
  [E in HookResult["event"]]: (data: Payload) => ResultOf<E> | Promise<ResultOf<E>>;
} = {
  "session-start": (data) => {
    const root = resolvedRoot();
    const project = pathFrom(process.env.CLAUDE_PROJECT_DIR, process.cwd()) ?? payloadCwd(data);
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
    const processCwd = pathFrom(process.cwd());
    const vault =
      sessionStart(data, { ...options, processCwd }) ??
      (cloud && root ? sessionContext(root, null, { data, ...options, cwd: project }) : null);
    const context = [vault, cloud, syncNote, linked].filter(Boolean).join("\n");
    // `llmos doctor` reads this record to prove the hooks run for this agent;
    // a failure never changes the result.
    try {
      beat(data);
    } catch {}
    return { event: "session-start", context: context || null };
  },
  "pre-tool-use": (data) => ({ event: "pre-tool-use", context: preToolUse(data) }),
  "post-tool-use": async (data) => ({
    event: "post-tool-use",
    // Loaded only here: the frontmatter and vault code costs startup time.
    context: await (await import("./stamp.ts")).postToolUse(data),
  }),
  "guard-bash": (data) => {
    const toolInput = toolInputOf(data);
    const command = toolInput
      ? firstTruthy([toolInput.command, toolInput.CommandLine], undefined)
      : undefined;
    const denial =
      typeof command === "string" && command ? firstDenial(command, guardFolders(data)) : null;
    return { event: "guard-bash", denial };
  },
  stop: () => {
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
    return { event: "stop" };
  },
};

async function run(event: string | undefined): Promise<void> {
  if (event === undefined || !Object.hasOwn(handlers, event)) return;
  const name = event as HookResult["event"];
  const data = await readSessionPayload(name);
  const result = await handlers[name](data);
  emit(result, isAntigravityPayload(data));
}

try {
  await run(process.argv[2]);
} catch {
  // A hook failure must never block the tool call.
}
