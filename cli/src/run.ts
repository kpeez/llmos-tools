/**
 * The one module that starts a subprocess. A Biome plugin (`../lint/subprocess.grit`)
 * fails on `Bun.spawn`, `Bun.spawnSync`, `Bun.$`, and `node:child_process` anywhere
 * else, so no child can run without a time limit: every option type here
 * makes `timeoutMs` required. A hook adds the limits of its steps
 * (`hook-limits.ts`), and a test checks that they fit the hook's timeout.
 *
 * A hook arms a deadline (`setDeadline`, from `hook-limits.ts`). Then `run`
 * and `start` cut each call's limit to the time left, and `run` starts no
 * call once the time is gone, so the calls of a hook together stay inside
 * its timeout. The deadline is the hook's timeout less a small reserve, so a
 * call it cuts is one that the harness would have killed too.
 *
 * Pass a named constant that says why the limit fits. `UNBOUNDED` is for a
 * child that is the session's own server or a pass-through of the caller's
 * own command; name it at the call site.
 */

type Env = Record<string, string | undefined>;
type Input = Bun.SpawnOptions.Writable;
type Output = Bun.SpawnOptions.Readable;

let deadline = Number.POSITIVE_INFINITY;

/** Stop all subprocesses of this process at `epochMs`. */
export function setDeadline(epochMs: number): void {
  deadline = epochMs;
}

/** The ms left before the deadline; `Infinity` with none. */
export function remainingMs(): number {
  return deadline - Date.now();
}

/** No limit: the child lives as long as its caller wants it to. */
export const UNBOUNDED = Number.POSITIVE_INFINITY;

export interface RunOptions<
  In extends Input = Input,
  Out extends Output = Output,
  Err extends Output = Output,
> {
  /** The most the child may run, in ms; the child gets `killSignal` after it. */
  timeoutMs: number;
  cwd?: string;
  env?: Env;
  stdin?: In;
  stdout?: Out;
  stderr?: Err;
  killSignal?: NodeJS.Signals;
}

export interface RunResult {
  /** `null` when a signal ended the child. */
  exitCode: number | null;
  signalCode: string | number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  /** The deadline left no time, so the child never started. */
  skipped: boolean;
}

function limit(timeoutMs: number): { timeout?: number } {
  const ms = Math.floor(Math.min(timeoutMs, remainingMs()));
  return Number.isFinite(ms) ? { timeout: ms } : {};
}

/** The deadline is past, or too near for a call to do anything. */
function exhausted(): boolean {
  return remainingMs() <= MIN_START_MS;
}

/** A call with less time than this left would only be killed at once. */
const MIN_START_MS = 50;

function spawnOptions<In extends Input, Out extends Output, Err extends Output>(
  options: RunOptions<In, Out, Err>,
) {
  const { timeoutMs, env, ...rest } = options;
  return { ...rest, ...(env ? { env: env as Record<string, string> } : {}), ...limit(timeoutMs) };
}

/** Run `cmd` to its end or its limit. Throws when the program cannot start. */
export function run(cmd: string[], options: RunOptions): RunResult {
  if (exhausted()) {
    return {
      exitCode: null,
      signalCode: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      skipped: true,
    };
  }
  const result = Bun.spawnSync({ cmd, ...spawnOptions(options) });
  return {
    exitCode: result.exitCode,
    signalCode: result.signalCode ?? null,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    timedOut: result.exitedDueToTimeout === true,
    skipped: false,
  };
}

/** Start `cmd` and return it at once; it gets `killSignal` after the limit. */
export function start<
  const In extends Input = "ignore",
  const Out extends Output = "inherit",
  const Err extends Output = "inherit",
>(cmd: string[], options: RunOptions<In, Out, Err>): Bun.Subprocess<In, Out, Err> {
  return Bun.spawn({ cmd, ...spawnOptions(options) });
}

/**
 * Start `cmd` as a child that outlives this process: its own process group,
 * no stdin, and no hold on this process's exit. The caller ends no later than
 * the child, so no limit can reach it; the child bounds itself (an idle stop,
 * or work that ends).
 */
export function startDetached(
  cmd: string[],
  options: { cwd?: string; env?: Env; stdout?: Output; stderr?: Output },
): void {
  const { env, ...rest } = options;
  const child = Bun.spawn({
    cmd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    ...rest,
    ...(env ? { env: env as Record<string, string> } : {}),
    detached: true,
  });
  child.unref();
}
