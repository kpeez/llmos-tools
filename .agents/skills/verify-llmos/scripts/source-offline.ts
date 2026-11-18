#!/usr/bin/env bun
/**
 * Run `source add` against the recorded web pages in cli/test/fixtures/web
 * instead of the network. The command code is the real one. Only `Context.fetch`
 * (the network seam) is replaced, so no request leaves the machine.
 *
 * Usage: bun scripts/source-offline.ts <vault-root> <source> [more arguments]
 * Prints the CLI stdout and stderr, then exits with the CLI exit code.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { defaultContext, runCli } from "../../../../cli/src/cli.ts";
import { COMMANDS } from "../../../../cli/src/commands.ts";
import type { Fetcher } from "../../../../cli/src/sources.ts";

const RECORDED = resolve(import.meta.dir, "../../../../cli/test/fixtures/web");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

const requests: string[] = [];
const fetch: Fetcher = async (url) => {
  requests.push(url);
  const { host, pathname } = new URL(url);
  const file = [join(RECORDED, host, pathname), join(RECORDED, host, `${pathname}.html`)].find(
    (path) => existsSync(path) && extname(path) !== "",
  );
  if (file === undefined) {
    return { status: 404, url, contentType: "text/html", body: new Uint8Array() };
  }
  const contentType = TYPES[extname(file)] ?? "application/octet-stream";
  return { status: 200, url, contentType, body: new Uint8Array(readFileSync(file)) };
};

const [root, ...argv] = process.argv.slice(2);
if (root === undefined || argv.length === 0) {
  console.error("usage: source-offline.ts <vault-root> <source> [arguments]");
  process.exit(2);
}
const context = { ...defaultContext(process.env), root: () => root, fetch };
const result = await runCli(["source", "add", ...argv], COMMANDS, context);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
console.error(`replayed requests: ${requests.length}`);
process.exit(result.exitCode);
