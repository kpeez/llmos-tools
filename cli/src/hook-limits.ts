/**
 * Each hook's deadline: the time its subprocesses may use together, the
 * `timeout` of the hook in `../hooks/hooks.json` less `HOOK_RESERVE_MS`. A
 * call loses time only in the last `HOOK_RESERVE_MS` before the harness kill:
 * the deadline gives that time to the output. The limit of a single call
 * stays what it was; near the deadline `run.ts` cuts a call to the time left,
 * and starts none once the time is gone. `runHook` in `hooks/runtime.ts` arms the deadline,
 * and `test/hooks/manifest.test.ts` checks `HOOK_TIMEOUT_MS` against
 * `hooks.json`.
 */

import { setDeadline } from "./run.ts";

/**
 * The time to write the output and exit after the deadline. A session-start
 * hook that is cut by the deadline ends 0.1 to 0.2 s later on the development
 * machine; the reserve is more than twice that.
 */
export const HOOK_RESERVE_MS = 500;

/** The `timeout` of each hook event (the argument in `hooks.json`), in ms. */
export const HOOK_TIMEOUT_MS: Record<string, number> = {
  "session-start": 10_000,
  "pre-tool-use": 10_000,
  "guard-bash": 10_000,
  "post-tool-use": 10_000,
  stop: 30_000,
};

/** Arm the deadline of `event`; an unknown event gets none. */
export function armHookDeadline(event: string | undefined): void {
  const timeout = event === undefined ? undefined : HOOK_TIMEOUT_MS[event];
  if (timeout !== undefined) {
    setDeadline(Date.now() - process.uptime() * 1000 + timeout - HOOK_RESERVE_MS);
  }
}
