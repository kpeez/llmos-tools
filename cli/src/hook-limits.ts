/**
 * Each hook's deadline: the time its subprocesses may use together. The
 * limit of a single call stays what it was; the deadline cuts a call short
 * when little time is left and skips the calls after it (`run.ts`).
 * `hooks/main.ts` arms the deadline of its event, and
 * `test/hooks/manifest.test.ts` checks that each deadline plus
 * `HOOK_RESERVE_MS` is under the `timeout` of that event's command in
 * `../hooks/hooks.json`. The reserve is the time to start Bun, load the
 * bundle, and write the output.
 */

import { setDeadline } from "./run.ts";

export const HOOK_RESERVE_MS = 1_500;

/** The deadline of each hook event (the argument in `hooks.json`), in ms after the process starts. */
export const HOOK_DEADLINE_MS: Record<string, number> = {
  "session-start": 8_000,
  "pre-tool-use": 8_000,
  "guard-bash": 8_000,
  "post-tool-use": 8_000,
  stop: 28_000,
};

/** Arm the deadline of `event`; an unknown event gets none. */
export function armHookDeadline(event: string | undefined): void {
  const ms = event === undefined ? undefined : HOOK_DEADLINE_MS[event];
  if (ms !== undefined) setDeadline(Date.now() - process.uptime() * 1000 + ms);
}
