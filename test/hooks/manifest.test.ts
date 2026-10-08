/**
 * Every `hooks.json` command runs the committed bundle with an event the
 * entry point knows. A misspelled event would exit 0 and do nothing, and
 * no harness would report it.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "./helpers.ts";

const COMMAND =
  /^bun --no-env-file --config=\/dev\/null "\$CLAUDE_PLUGIN_ROOT"\/dist\/hooks\.js ([a-z-]+)$/;

test("each hook command runs the bundle with a known event", () => {
  const hooks = JSON.parse(readFileSync(join(TOOLS, "hooks", "hooks.json"), "utf8")).hooks;
  const events: Record<string, string[]> = {};
  for (const [name, groups] of Object.entries(hooks) as [
    string,
    { hooks: { command: string }[] }[],
  ][]) {
    events[name] = groups.flatMap((group) =>
      group.hooks.map((hook) => COMMAND.exec(hook.command)?.[1] ?? hook.command),
    );
  }
  expect(events).toEqual({
    SessionStart: ["session-start"],
    PreToolUse: ["pre-tool-use", "guard-bash"],
    PostToolUse: ["post-tool-use"],
    Stop: ["stop"],
  });
});
