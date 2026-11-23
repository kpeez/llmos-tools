/**
 * Entry point of the hooks that run on every tool call
 * (`dist/pre-tool-use.js`): `pre-tool-use` and `guard-bash`. It imports no
 * YAML, memory, or vault-model code, so Bun loads little before the hook
 * answers. The other events are in `main.ts` (`dist/hooks.js`).
 *
 * - `pre-tool-use`: the vault context of the call as
 *   `hookSpecificOutput.additionalContext` JSON on stdout. For a shell tool
 *   (`Bash`, `run_command`) it also runs the guard, so one process answers
 *   a Bash call. A denial wins: exit code 2 with the reason on stderr. A
 *   failure of one part never hides the other.
 * - `guard-bash`: the guard alone, for a caller that sends only shell
 *   commands (the Hermes adapter).
 */

import {
  firstTruthy,
  type Payload,
  pathFrom,
  toolInputOf,
  toolNameOf,
  workspacePath,
} from "./common.ts";
import { preToolUse } from "./context.ts";
import { checkCommand } from "./guard.ts";
import { type Handlers, runHook } from "./runtime.ts";

const SHELL_TOOLS = new Set(["Bash", "run_command"]);

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

/** The reason the guard denies the shell command of the raw payload, else null. */
function guardDenial(raw: Payload): string | null {
  const toolInput = toolInputOf(raw);
  const command = toolInput
    ? firstTruthy([toolInput.command, toolInput.CommandLine], undefined)
    : undefined;
  return typeof command === "string" && command ? firstDenial(command, guardFolders(raw)) : null;
}

/** `compute()`, or null when it fails: a hook failure never blocks the tool call. */
function orNull(compute: () => string | null): string | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

const handlers: Handlers<"pre-tool-use" | "guard-bash"> = {
  "pre-tool-use": ({ raw, data }) => ({
    event: "pre-tool-use",
    context: orNull(() => preToolUse(data)),
    denial: SHELL_TOOLS.has(toolNameOf(raw)) ? orNull(() => guardDenial(raw)) : null,
  }),
  "guard-bash": ({ raw }) => ({ event: "guard-bash", denial: guardDenial(raw) }),
};

await runHook(process.argv[2], handlers);
