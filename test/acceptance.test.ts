/**
 * #34 acceptance through the real entry point (`bin/llmos-vault.ts`) as a
 * process: with Obsidian unreachable, the headless writes succeed and
 * `move` exits 3. "Unreachable" is shown two ways: no obsidian-cli on PATH,
 * and an obsidian-cli that answers the way it does with the app closed
 * (its message, seen in a live test, and exit 1) and logs every call.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dailyNote,
  executable,
  isolatedEnv,
  makeVault,
  read,
  scratch,
  TOOLS,
  writeFiles,
} from "./helpers.ts";

const ALPHA = "---\ncreated: 2026-07-01\n---\n\n# Alpha\n";

function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function closedApp(): { bin: string; log: string } {
  const bin = scratch("closed-obsidian");
  const log = join(bin, "calls.log");
  executable(
    join(bin, "obsidian-cli"),
    `#!/bin/sh\necho "$*" >> "${log}"\n` +
      'echo "The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again." >&2\nexit 1\n',
  );
  return { bin, log };
}

function run(root: string, argv: string[], pathDirs: string[]) {
  const env = isolatedEnv({
    LLMOS_ROOT: root,
    // `bun test` runs in UTC; the child must agree on what day it is.
    TZ: process.env.TZ ?? "UTC",
    PATH: [...pathDirs, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  });
  const result = Bun.spawnSync([process.execPath, join(TOOLS, "bin/llmos-vault.ts"), ...argv], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("with Obsidian unreachable", () => {
  for (const [label, withCli] of [
    ["obsidian-cli reports the app closed", true],
    ["obsidian-cli is not on PATH", false],
  ] as const) {
    test(`${label}: writes succeed headlessly and move exits 3`, () => {
      const day = today();
      const daily = `reviews/daily/${day}.md`;
      const marker = "<!-- llmos-activity:start hash=9a8b7c6d5e4f -->";
      const root = makeVault({ "notes/alpha.md": ALPHA });
      writeFiles(root, { [daily]: dailyNote(day, marker) });
      const app = closedApp();
      const path = withCli ? [app.bin] : [];

      expect(run(root, ["set-property", "alpha", "status", "active"], path)).toEqual({
        exitCode: 0,
        stdout: "Set: status = active\n",
        stderr: "",
      });
      expect(run(root, ["append", "alpha", "Appended line."], path).exitCode).toBe(0);
      expect(run(root, ["daily", "append-thought", "Thought with Obsidian closed."], path)).toEqual(
        {
          exitCode: 0,
          stdout: `Appended to: ${daily}\n`,
          stderr: "",
        },
      );
      expect(read(root, "notes/alpha.md")).toBe(
        "---\ncreated: 2026-07-01\nstatus: active\n---\n\n# Alpha\nAppended line.\n",
      );
      expect(read(root, daily)).toContain(
        "Earlier thought.\n\nThought with Obsidian closed.\n\n## Projects",
      );
      expect(read(root, daily)).toContain(marker);
      expect(existsSync(app.log)).toBe(false); // the writes never called obsidian-cli

      const moved = run(root, ["move", "alpha", "archive/alpha.md"], path);
      expect(moved.exitCode).toBe(3);
      expect(moved.stdout).toBe("");
      expect(moved.stderr).toContain(withCli ? "unable to find Obsidian" : "not on PATH");
      expect(existsSync(join(root, "notes/alpha.md"))).toBe(true);
      if (withCli) {
        expect(readFileSync(app.log, "utf8")).toBe(
          "vault=llmOS move path=notes/alpha.md to=archive/alpha.md\n",
        );
      }
    });
  }
});
