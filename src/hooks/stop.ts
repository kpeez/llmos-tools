/**
 * Stop: update the qmd keyword index of the `llmos` collection, only if
 * this session's stamp hook left a dirty flag.
 *
 * It never embeds: loading the embedding model takes seconds, too long for
 * the end of every turn. Embedding is done by running `llmos-vault reindex`
 * by hand; `llmos-vault health` reports how many documents still need it.
 *
 * It runs `llmos-vault reindex --no-embed` when `llmos-vault` is on `PATH`.
 * If that install lacks the flag or the verb, or fails, it runs `qmd update
 * -c llmos`. The flag clears only after one of them succeeds, so a failure
 * stays retryable. A failure prints a short diagnostic on stderr and never
 * blocks the turn. A turn that did not touch the vault spawns nothing. This
 * hook never imports qmd itself.
 *
 * The commands' stdout goes to the hook's stderr: a harness may read a Stop
 * hook's stdout as JSON, and `llmos-vault reindex` prints a JSON report.
 */

import { existsSync, rmSync } from "node:fs";
import { COLLECTION, flagPath, type Payload, sessionId } from "./common.ts";

export function warn(message: string): void {
  process.stderr.write(`llmos qmd hook: ${message}\n`);
}

/** Run `command`, all its output on stderr; a description of the failure, or `null` on success. */
function run(label: string, command: string[]): string | null {
  try {
    const result = Bun.spawnSync({ cmd: command, stdin: "ignore", stdout: 2, stderr: "inherit" });
    if (result.exitCode === 0) return null;
    return `${label} exited ${result.exitCode ?? result.signalCode}`;
  } catch (error) {
    return `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function stop(data: Payload): void {
  const flag = flagPath(sessionId(data), COLLECTION);
  if (!existsSync(flag)) return;
  const failures: string[] = [];
  const cli = Bun.which("llmos-vault");
  if (cli !== null) {
    const failure = run("llmos-vault reindex --no-embed", [cli, "reindex", "--no-embed"]);
    if (failure === null) {
      rmSync(flag, { force: true });
      return;
    }
    failures.push(failure);
  }
  const failure = run("qmd update", ["qmd", "update", "-c", COLLECTION]);
  if (failure === null) {
    if (failures.length > 0) warn(`${failures[0]}; ran qmd update instead`);
    rmSync(flag, { force: true });
    return;
  }
  failures.push(failure);
  warn(`${failures.join("; ")}; dirty flag retained for retry`);
}
