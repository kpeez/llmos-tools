/**
 * `llmos doctor` as a process, with a stand-in obsidian-cli, this install's
 * `qmd` (linked from `bin/qmd.ts`), and a temporary qmd index built through
 * the SDK. PATH holds only the stand-ins, Bun, and the system folders.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileSha256, recordHeartbeat } from "../src/heartbeat.ts";
import { MEMORY_TOOLS, READ_TOOLS, WRITE_TOOLS } from "../src/mcp-names.ts";
import { openQmd, qmdLocation } from "../src/qmd.ts";
import { CLI, executable, isolatedEnv, makeVault, scratch, writeFiles } from "./helpers.ts";

const SENTINEL = "---\nstatus: active\n---\n\n# llmOS\n\nShared test vault.\n";

interface Setup {
  root: string;
  bin: string;
  env: Record<string, string>;
}

async function setup(
  options: { collectionPath?: string; sentinelIndexed?: boolean; memory?: boolean } = {},
): Promise<Setup> {
  const root = makeVault(options.sentinelIndexed === false ? {} : { "llmOS.md": SENTINEL });
  const bin = scratch("doctor-bin");
  executable(
    join(bin, "obsidian-cli"),
    `#!/bin/sh
case "$FAKE_OBSIDIAN_MODE" in
  wrong) echo "# Not llmOS"; exit 0 ;;
  hang) sleep 30 ;;
esac
[ "$*" = "vault=llmOS read path=llmOS.md" ] || { echo "unexpected: $*" >&2; exit 2; }
cat "$FAKE_VAULT_ROOT/llmOS.md" | sed '$ { /^$/d; }'
`,
  );
  symlinkSync(join(CLI, "bin/qmd.ts"), join(bin, "qmd"));
  const env = isolatedEnv({
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    LLMOS_ROOT: root,
    FAKE_VAULT_ROOT: root,
    LLMOS_DOCTOR_OS: "Darwin",
  });
  const config = join(env.QMD_CONFIG_DIR as string, "index.yml");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(
    config,
    `collections:\n  llmos:\n    path: ${options.collectionPath ?? root}\n    pattern: "**/*.md"\n` +
      (options.memory === false
        ? ""
        : `  memory:\n    path: ${root}\n    pattern: "projects/*/memory/*.md"\n`),
  );
  mkdirSync(dirname(env.INDEX_PATH as string), { recursive: true });
  const store = await openQmd(qmdLocation(env), true);
  try {
    await store.update({ collections: ["llmos", ...(options.memory === false ? [] : ["memory"])] });
  } finally {
    await store.close();
  }
  if (options.sentinelIndexed === false) writeFiles(root, { "llmOS.md": SENTINEL });
  // The CLI installed: the link the plugin's MCP launcher follows.
  mkdirSync(join(env.HOME as string, ".local", "bin"), { recursive: true });
  symlinkSync(join(CLI, "bin", "llmos.ts"), join(env.HOME as string, ".local", "bin", "llmos"));
  // The plugin installed for Claude Code, and its hooks seen running.
  const plugin = join(
    env.HOME as string,
    ".claude",
    "plugins",
    "cache",
    "llmos-tools",
    "llmos",
    "1",
  );
  writeFiles(plugin, { "dist/hooks.js": "// hooks\n" });
  writeFiles(join(env.HOME as string, ".claude", "plugins"), {
    "installed_plugins.json": JSON.stringify({
      plugins: { "llmos@llmos-tools": [{ installPath: plugin }] },
    }),
  });
  recordHeartbeat(
    "claude",
    {
      time: new Date().toISOString(),
      bun: Bun.version,
      bundleSha256: fileSha256(join(plugin, "dist", "hooks.js")),
      pluginRoot: plugin,
    },
    env,
  );
  return { root, bin, env };
}

function doctor(env: Record<string, string>) {
  const result = Bun.spawnSync([process.execPath, join(CLI, "bin/llmos.ts"), "doctor"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

function failed(result: ReturnType<typeof doctor>, check: string, repair: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain(`FAIL ${check}:`);
  expect(result.stdout).toContain(`REPAIR ${repair}`);
}

describe("llmos doctor", () => {
  test("a healthy setup passes every check", async () => {
    const { env } = await setup();
    const result = doctor(env);
    expect(result.stdout).not.toContain("FAIL ");
    for (const check of [
      "vault-root",
      "obsidian-cli",
      "obsidian-vault",
      "qmd",
      "qmd-collection",
      "qmd-memory-collection",
      "memory-embeddings",
      "service",
      "qmd-index",
      "qmd-retrieval",
      "mcp-server",
      "hooks-claude",
    ]) {
      expect(result.stdout).toContain(`PASS ${check}:`);
    }
    expect(result.stdout).toContain("(qmd 2.8.3");
    expect(result.stdout).toContain(
      `mcp lists ${READ_TOOLS.length + MEMORY_TOOLS.length + WRITE_TOOLS.length} tools`,
    );
    expect(result.exitCode).toBe(0);
  });

  test("an MCP server the launcher cannot start fails with the install repair", async () => {
    const { env } = await setup();
    rmSync(join(env.HOME as string, ".local", "bin", "llmos"));
    failed(doctor(env), "mcp-server", "Run /setup-llmos");
    const old = scratch("old-install");
    writeFiles(old, { "bin/llmos.ts": "process.exit(1);\n" });
    symlinkSync(join(old, "bin", "llmos.ts"), join(env.HOME as string, ".local", "bin", "llmos"));
    const broken = doctor(env);
    failed(broken, "mcp-server", "Run /setup-llmos");
    expect(broken.stdout).toContain("exited before listing its tools");
  });

  test("hooks that never ran fail with the repair", async () => {
    const { env } = await setup();
    rmSync(join(env.HOME as string, ".local", "state", "llmos", "hooks.json"));
    failed(doctor(env), "hooks-claude", "Start a fresh Claude Code session");
  });

  test("a root without AGENTS.md fails", async () => {
    const { root, env } = await setup();
    rmSync(join(root, "AGENTS.md"));
    failed(doctor(env), "vault-root", "Run /setup-llmos");
  });

  test("obsidian-cli failures name the platform's repair", async () => {
    const { bin, env } = await setup();
    const wrong = doctor({ ...env, FAKE_OBSIDIAN_MODE: "wrong" });
    failed(wrong, "obsidian-vault", `open -a Obsidian "`);
    expect(wrong.stdout).toContain("content does not match");

    const hung = doctor({
      ...env,
      FAKE_OBSIDIAN_MODE: "hang",
      LLMOS_DOCTOR_OS: "Linux",
      LLMOS_DOCTOR_TIMEOUT: "1",
    });
    failed(hung, "obsidian-vault", 'obsidian "');
    expect(hung.stdout).toContain("obsidian-cli timed out after 1s");
    expect(hung.stdout).toContain("PASS qmd:");

    rmSync(join(bin, "obsidian-cli"));
    failed(
      doctor({ ...env, LLMOS_DOCTOR_OS: "Linux" }),
      "obsidian-cli",
      "sudo snap install obsidian --classic",
    );
  });

  test("qmd must be exactly one command on PATH, and this install's", async () => {
    const { bin, env } = await setup();
    const other = scratch("other-qmd");
    executable(join(other, "qmd"), "#!/bin/sh\necho qmd 0.0.1\n");

    const two = doctor({ ...env, PATH: `${env.PATH}:${other}` });
    failed(two, "qmd", "Remove every qmd except");
    expect(two.stdout).toContain("mise uninstall npm:@tobilu/qmd");
    expect(two.stdout).toContain("2 different qmd commands on PATH");

    rmSync(join(bin, "qmd"));
    const foreign = doctor({ ...env, PATH: `${env.PATH}:${other}` });
    failed(foreign, "qmd", "Run /setup-llmos");
    expect(foreign.stdout).toContain("is not this install's qmd");

    failed(doctor(env), "qmd", "Run /setup-llmos");
  });

  test("a collection at another path fails with the re-add repair", async () => {
    const elsewhere = scratch("elsewhere");
    const { env } = await setup({ collectionPath: elsewhere });
    failed(doctor(env), "qmd-collection", "qmd collection remove llmos && qmd collection add");
  });

  test("a missing memory collection fails with the add command, and the service is reported", async () => {
    const { env, root } = await setup({ memory: false });
    const result = doctor(env);
    failed(
      result,
      "qmd-memory-collection",
      `qmd collection add "${realpathSync(root)}" --name memory --mask 'projects/*/memory/*.md'`,
    );
    expect(result.stdout).toContain("PASS service: off (LLMOS_SERVICE=off)");
    const live = doctor({ ...env, LLMOS_SERVICE: "on", XDG_STATE_HOME: scratch("st") });
    expect(live.stdout).toContain("PASS service: not running");
  });

  test("an unindexed or stale sentinel fails with the reindex repair", async () => {
    const unindexed = await setup({ sentinelIndexed: false });
    failed(doctor(unindexed.env), "qmd-index", "llmos reindex");

    const stale = await setup();
    writeFiles(stale.root, { "llmOS.md": `${SENTINEL}\nEdited after indexing.\n` });
    const result = doctor(stale.env);
    expect(result.stdout).toContain("PASS qmd-index:");
    failed(result, "qmd-retrieval", "llmos reindex");
  });
});
