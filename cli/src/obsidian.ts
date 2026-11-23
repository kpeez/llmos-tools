/**
 * The obsidian-cli subprocess, for the two writes only the running app can
 * do: `move` (Obsidian rewrites every backlink) and `create --template`
 * (Obsidian expands the template). Every other write is a headless file
 * write (`write.ts`).
 *
 * The argv is `obsidian-cli vault=<root folder name> <verb> path=<note>
 * key=value...`, passed as a list, so no value needs shell quoting.
 */

import { basename } from "node:path";
import { markDirty } from "./dirty.ts";

/** The exit code for "Obsidian is not running", kept from the Python CLI. */
export const EXIT_OBSIDIAN_NOT_RUNNING = 3;

// The closed-app message seen in a live test (2026-07-17) was "The CLI is
// unable to find Obsidian. Please make sure Obsidian is running and try
// again." The other signals are best-effort.
const NOT_RUNNING_SIGNALS = [
  "unable to find obsidian",
  "not running",
  "connection refused",
  "econnrefused",
  "could not connect",
  "unable to connect",
  "no vault is open",
];

/** obsidian-cli could not reach a running Obsidian app. */
export class ObsidianNotRunning extends Error {
  override name = "ObsidianNotRunning";
}

/** obsidian-cli ran and failed for another reason. */
export class ObsidianCliError extends Error {
  override name = "ObsidianCliError";
}

/** Runs obsidian-cli with an argv and returns its result; replaceable in tests. */
export type ObsidianRunner = (argv: string[]) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export const spawnObsidian: ObsidianRunner = (argv) => {
  const result = Bun.spawnSync(["obsidian-cli", ...argv], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

/**
 * Run one obsidian-cli verb on the note at vault-relative `path` and return
 * its stdout. Throws `ObsidianNotRunning` when obsidian-cli is missing or
 * cannot reach the app, and `ObsidianCliError` for any other failure.
 */
export function runObsidian(
  root: string,
  verb: string,
  path: string,
  params: Record<string, string>,
  run: ObsidianRunner = spawnObsidian,
): string {
  const argv = [`vault=${basename(root)}`, verb, `path=${path}`];
  for (const [key, value] of Object.entries(params)) argv.push(`${key}=${value}`);
  let result: ReturnType<ObsidianRunner>;
  try {
    result = run(argv);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      throw new ObsidianNotRunning(
        "obsidian-cli is not on PATH -- is Obsidian installed and running?",
      );
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    if (NOT_RUNNING_SIGNALS.some((signal) => stderr.toLowerCase().includes(signal))) {
      throw new ObsidianNotRunning(
        `obsidian-cli could not reach a running Obsidian app: ${stderr}`,
      );
    }
    throw new ObsidianCliError(`obsidian-cli ${verb} failed: ${stderr}`);
  }
  markDirty();
  return result.stdout;
}
