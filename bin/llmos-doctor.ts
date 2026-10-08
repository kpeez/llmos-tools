#!/usr/bin/env bun
// llmos-doctor: check this host's llmOS prerequisites (read-only).
import { parseArgs } from "node:util";
import { doctor } from "../src/doctor.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { help: { type: "boolean", short: "h" } },
});
if (values.help) {
  console.log(
    "Usage: llmos-doctor\n\n" +
      "Check the vault root, Obsidian, qmd, the MCP server, and the plugin hooks on\n" +
      "this host. Prints PASS or FAIL per check and a REPAIR command after each\n" +
      "failure; exits 0 only when all pass.",
  );
  process.exit(0);
}
const { lines, exitCode } = await doctor(process.env);
await Bun.write(Bun.stdout, `${lines.join("\n")}\n`);
process.exit(exitCode);
