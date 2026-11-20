#!/usr/bin/env bun
import { main } from "../src/cli.ts";
import { COMMANDS } from "../src/commands.ts";

const argv = process.argv.slice(2);

// On macOS, libggml-metal aborts at process exit while a model it loaded is
// resident (ggml-org/llama.cpp#22593) unless GGML_METAL_NO_RESIDENCY is set
// before the native library loads; setting process.env at run time does not
// reach it. The verbs that can load a model run again with it set.
const loadsModels =
  argv[0] === "search" ||
  argv[0] === "reindex" ||
  argv[0] === "mcp" ||
  (argv[0] === "memory" && argv[1] === "search") ||
  (argv[0] === "service" && argv[1] === "serve");
if (process.platform === "darwin" && loadsModels && !process.env.GGML_METAL_NO_RESIDENCY) {
  const child = Bun.spawn([process.execPath, import.meta.path, ...argv], {
    env: { ...process.env, GGML_METAL_NO_RESIDENCY: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await child.exited);
}

await main(argv, COMMANDS);
