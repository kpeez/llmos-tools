#!/usr/bin/env bun
// This install's `qmd` command: the pinned @tobilu/qmd package's own launcher,
// run under Bun, so the qmd on PATH is the version the CLI imports.
import { constants } from "node:os";
import { resolve } from "node:path";
import { start, UNBOUNDED } from "../src/run.ts";

const launcher = resolve(import.meta.dir, "../node_modules/@tobilu/qmd/bin/qmd");
const child = start([process.execPath, launcher, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  // The caller's own qmd command, which has no limit of its own.
  timeoutMs: UNBOUNDED,
});
const code = await child.exited;
const signal = child.signalCode;
const signalNumber = typeof signal === "number" ? signal : signal ? constants.signals[signal] : 0;
process.exit(signal ? 128 + (signalNumber ?? 0) : code);
