/**
 * `run()` and the hook deadline. A hook's calls together stay inside its
 * timeout because the deadline cuts a call short and skips the calls after it.
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { remainingMs, run, setDeadline } from "../src/run.ts";
import { makeVault, removeTemporaryFolders, runHook, temporaryFolder } from "./hooks/helpers.ts";

afterEach(() => {
  setDeadline(Number.POSITIVE_INFINITY);
  removeTemporaryFolders();
});

test("a call stops at its own limit", () => {
  const started = Date.now();
  const result = run(["sleep", "5"], { timeoutMs: 200 });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("the deadline cuts a call short and starts no call after it", () => {
  setDeadline(Date.now() + 300);
  const started = Date.now();
  expect(run(["sleep", "5"], { timeoutMs: 60_000 }).timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(remainingMs()).toBeLessThanOrEqual(0);
  const second = Date.now();
  const skipped = run(["echo", "ran"], { timeoutMs: 60_000, stdout: "pipe" });
  expect(skipped.skipped).toBe(true);
  expect(skipped.timedOut).toBe(false);
  expect(skipped.stdout.toString()).toBe("");
  expect(Date.now() - second).toBeLessThan(100);
});

test("a deadline that is not a whole number of ms still runs a call", () => {
  setDeadline(Date.now() + 5_000.7);
  const result = run(["echo", "ran"], { timeoutMs: 20_000, stdout: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("ran\n");
});

test("a whole call does not start when its full limit does not fit", () => {
  setDeadline(Date.now() + 5_000);
  const result = run(["echo", "ran"], { timeoutMs: 20_000, whole: true, stdout: "pipe" });
  expect(result.skipped).toBe(true);
  expect(result.stdout.toString()).toBe("");
});

test("a cloud session start with a hung git stops linking at the hook deadline", () => {
  const tmp = temporaryFolder();
  const parent = join(tmp, "work");
  const vault = makeVault(join(parent, "vault"));
  for (const name of ["repo1", "repo2", "repo3", "repo4", "repo5"]) {
    mkdirSync(join(parent, name, ".git"), { recursive: true });
  }
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
  chmodSync(join(bin, "git"), 0o755);
  const started = Date.now();
  const result = runHook("session-start", { session_id: "s" }, tmp, {
    root: vault,
    env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_REMOTE: "true" },
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(result.stdout).toContain("Linking stopped at the hook deadline");
}, 30_000);
