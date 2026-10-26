/**
 * Run the TypeScript activity digest (`src/digest.ts`) on the digest edge
 * days (`digest_edge.ts`), with the stand-in `gh` and `opencode` of
 * `digest_stub.ts`, and observe what each run did: its `gh` calls, the
 * references its model prompts require, and the day's note and every vault
 * file afterwards.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MARKER_END, MARKER_START } from "../../src/daily.ts";
import { existingHash } from "../../src/digest.ts";
import { writeDigestEdgeVault } from "./digest_edge.ts";
import type { DigestDay } from "./snapshot.ts";

const CLI = resolve(import.meta.dir, "../..");
const STUB = join(import.meta.dir, "digest_stub.ts");

interface DigestRun {
  exitCode: number;
  stdout: string;
}

/** What a day's runs did: the snapshot fields, and whether the second run changed any file. */
export type ObservedDay = Omit<DigestDay, "differs_from_python"> & { againChangedFiles: boolean };

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Every file under `root` by relative path, with its SHA-256. */
function fileHashes(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path)] = sha256(readFileSync(path));
    }
  };
  walk(root);
  return files;
}

/** The argument lists of the logged `gh` calls, in order. */
function ghCalls(logDir: string): string[][] {
  const log = join(logDir, "gh.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/** The references each logged model prompt requires, in call order ("?" when a prompt names none). */
function requiredReferences(logDir: string): string[] {
  return readdirSync(logDir)
    .filter((name) => name.startsWith("prompt-"))
    .sort((a, b) => Number(a.slice(7, -4)) - Number(b.slice(7, -4)))
    .map((name) => readFileSync(join(logDir, name), "utf8"))
    .map((prompt) => /MUST appear in your output: (.*?)\. Summarize/s.exec(prompt)?.[1] ?? "?");
}

/** One digest run for `day` on `root`, with the stubs in `bin` logging to `logDir`. */
function runDigest(bin: string, root: string, day: string, logDir: string): DigestRun {
  mkdirSync(logDir, { recursive: true });
  const result = Bun.spawnSync(["bun", join(CLI, "src/digest.ts"), "--root", root, "--date", day], {
    cwd: CLI,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DIGEST_LOG_DIR: logDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString() };
}

/**
 * Run the digest twice for each of `days`, in order, on one freshly
 * generated edge vault, and observe the first run of each day and whether
 * the second changed anything.
 */
export function runEdgeDays(days: readonly string[]): ObservedDay[] {
  const scratch = mkdtempSync(join(tmpdir(), "llmos-contract-digest-"));
  try {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    for (const role of ["gh", "opencode"]) {
      writeFileSync(join(bin, role), `#!/bin/sh\nexec bun "${STUB}" ${role} "$@"\n`, {
        mode: 0o755,
      });
    }
    const root = join(scratch, "vault");
    writeDigestEdgeVault(root);
    return days.map((day, index) => {
      const logDir = join(scratch, "logs", `${index}-first`);
      const first = runDigest(bin, root, day, logDir);
      const path = join(root, "daily", `${day}.md`);
      const note = existsSync(path) ? readFileSync(path, "utf8") : null;
      const files = fileHashes(root);
      const again = runDigest(bin, root, day, join(scratch, "logs", `${index}-again`));
      return {
        day,
        exit: first.exitCode,
        stdout: first.stdout,
        gh: ghCalls(logDir),
        required: requiredReferences(logDir),
        hash: note === null ? null : existingHash(note),
        markers:
          note === null
            ? []
            : note
                .split("\n")
                .filter((line) => line.includes(MARKER_START) || line.includes(MARKER_END)),
        note,
        files,
        again: again.stdout,
        againChangedFiles: !isDeepStrictEqual(fileHashes(root), files),
      };
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
