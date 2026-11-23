/**
 * Stop: update the qmd keyword index of the `llmos` collection, and of the
 * `memory` collection when it exists, only if a write to the configured vault
 * left its dirty flag (`../dirty.ts`), in this session or in any other process.
 *
 * It never embeds: loading the embedding model takes seconds, too long for
 * the end of every turn. Embedding is done by running `llmos reindex`
 * by hand; `llmos health` reports how many documents still need it.
 *
 * It runs `llmos reindex --no-embed` when `llmos` is on `PATH`; a reindex of
 * `llmos` also scans `memory`. If that install lacks the flag or the verb, or
 * fails, it runs `qmd update -c llmos`, which scans every collection (qmd's
 * `update` ignores `-c`). The flag clears only after one of them succeeds, and
 * only when no write set it again during the reindex, so a failure stays
 * retryable. A failure prints a short diagnostic on stderr and never
 * blocks the turn. A turn that did not touch the vault spawns nothing. This
 * hook never imports qmd itself.
 *
 * The commands' stdout goes to the hook's stderr: a harness may read a Stop
 * hook's stdout as JSON, and `llmos reindex` prints a JSON report.
 */

import { clearDirty, dirtyToken } from "../dirty.ts";
import { REINDEX_BUDGET_MS } from "../hook-limits.ts";
import { run } from "../run.ts";
import { COLLECTION, resolvedRoot } from "./common.ts";

export function warn(message: string): void {
  process.stderr.write(`llmos qmd hook: ${message}\n`);
}

const TIMED_OUT = "timed out";

/**
 * Run `command`, all its output on stderr, until `deadline` (ms since the epoch);
 * a description of the failure, or `null` on success.
 */
function runBefore(label: string, command: string[], deadline: number): string | null {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) return `${label} ${TIMED_OUT}`;
  try {
    const result = run(command, {
      stdin: "ignore",
      stdout: 2,
      stderr: "inherit",
      timeoutMs,
    });
    if (result.exitCode === 0) return null;
    if (result.timedOut) return `${label} ${TIMED_OUT}`;
    return `${label} exited ${result.exitCode ?? result.signalCode}`;
  } catch (error) {
    return `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function stop(): void {
  const root = resolvedRoot();
  if (root === null) return;
  const token = dirtyToken(root);
  if (token === null) return;
  const deadline = Date.now() + REINDEX_BUDGET_MS;
  const failures: string[] = [];
  const cli = Bun.which("llmos");
  if (cli !== null) {
    const failure = runBefore("llmos reindex --no-embed", [cli, "reindex", "--no-embed"], deadline);
    if (failure === null) {
      clearDirty(root, token);
      return;
    }
    failures.push(failure);
    // A timeout is not a missing verb: qmd update would only spend the budget again.
    if (failure.endsWith(TIMED_OUT)) {
      warn(`${failure}; dirty flag retained for retry`);
      return;
    }
  }
  const failure = runBefore("qmd update", ["qmd", "update", "-c", COLLECTION], deadline);
  if (failure === null) {
    if (failures.length > 0) warn(`${failures[0]}; ran qmd update instead`);
    clearDirty(root, token);
    return;
  }
  failures.push(failure);
  warn(`${failures.join("; ")}; dirty flag retained for retry`);
}
