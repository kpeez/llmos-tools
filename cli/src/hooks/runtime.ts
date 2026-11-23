/**
 * What every hook entry point shares: the result of each event, the one
 * writer of a hook's output channels, and the one function that arms the
 * event's deadline (`../hook-limits.ts`), reads the payload, runs the event's
 * handler, and emits its result. An entry point
 * (`main.ts`, `pre-tool-use.ts`) is a handler table and a call to `runHook`;
 * it holds only the code of its own events, so a bundle stays small.
 *
 * A hook failure never blocks the tool call: an error exits 0 without
 * output, and an unknown event does nothing.
 */

import { armHookDeadline } from "../hook-limits.ts";
import {
  isAntigravityPayload,
  type Payload,
  pathFrom,
  readPayload,
  workspacePath,
} from "./common.ts";

export type HookResult =
  | { event: "session-start"; context: string | null }
  | { event: "pre-tool-use"; context: string | null; denial: string | null }
  | { event: "post-tool-use"; context: string | null }
  | { event: "post-shell"; report: string | null }
  | { event: "guard-bash"; denial: string | null }
  | { event: "stop" };

export type HookEvent = HookResult["event"];

export type ResultOf<E extends HookEvent> = Extract<HookResult, { event: E }>;

/** The payload as the harness sent it, and with `cwd` resolved (see `sessionPayload`). */
export interface HookInput {
  raw: Payload;
  data: Payload;
}

/**
 * One handler per event of an entry point, each typed to return its own
 * event's result, so a handler cannot return the result of another event.
 */
export type Handlers<E extends HookEvent> = {
  [K in E]: (input: HookInput) => ResultOf<K> | Promise<ResultOf<K>>;
};

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function additionalContext(eventName: "PreToolUse" | "PostToolUse", context: string | null): void {
  if (!context) return;
  writeJson({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } });
}

function deny(denial: string): void {
  process.stderr.write(`${denial}\n`);
  process.exitCode = 2;
}

/**
 * The only writer of a hook's output channels. Each event keeps the envelope
 * its harness reads; the lint in `cli/lint/hook-channels.grit` bans
 * `process.stdout` elsewhere in the hooks.
 *
 * `pre-tool-use` answers for the context and the guard together: the context
 * on stdout, and a denial as exit code 2 with the reason on stderr (for
 * Antigravity, a `deny` decision). A denial wins.
 *
 * `post-shell` answers a removal report as PostToolUse `additionalContext`.
 * Antigravity reads only `{}` after a tool, so `pre-tool-use.ts` holds the
 * report and hands it over with the next `pre-tool-use`.
 */
export function emit(result: HookResult, antigravity: boolean): void {
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
        if (result.denial) writeJson({ decision: "deny", reason: result.denial });
        else {
          writeJson(
            result.context ? { decision: "allow", reason: result.context } : { decision: "allow" },
          );
        }
      } else {
        additionalContext("PreToolUse", result.context);
        if (result.denial) deny(result.denial);
      }
      return;
    case "post-tool-use":
      if (antigravity) writeJson({});
      else additionalContext("PostToolUse", result.context);
      return;
    case "post-shell":
      if (antigravity) writeJson({});
      else additionalContext("PostToolUse", result.report);
      return;
    case "guard-bash":
      if (antigravity) {
        writeJson(
          result.denial ? { decision: "deny", reason: result.denial } : { decision: "allow" },
        );
      } else if (result.denial) {
        deny(result.denial);
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
 * payload (see `guardFolders` in `pre-tool-use.ts`). Only the entry points
 * and this file read `process.cwd()`; the handlers take their scope from the
 * payload.
 */
function sessionPayload(event: HookEvent, data: Payload): Payload {
  const here = process.cwd();
  const named = pathFrom(data.cwd, here) ?? pathFrom(workspacePath(data), here);
  if (event === "guard-bash") return data;
  if (named !== null) return { ...data, cwd: named };
  return event === "session-start" ? data : { ...data, cwd: here };
}

/** Run the handler of `event`, and write its result. */
export async function runHook<E extends HookEvent>(
  event: string | undefined,
  handlers: Handlers<E>,
): Promise<void> {
  try {
    if (event === undefined || !Object.hasOwn(handlers, event)) return;
    armHookDeadline(event);
    const name = event as E;
    const raw = await readPayload();
    const result = await handlers[name]({ raw, data: sessionPayload(name, raw) });
    emit(result, isAntigravityPayload(raw));
  } catch {
    // A hook failure must never block the tool call.
  }
}
