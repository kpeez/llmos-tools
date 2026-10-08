/**
 * `llmos-doctor` as a process, with a stand-in obsidian-cli, this install's
 * `qmd` (linked from `bin/qmd.ts`), and a temporary qmd index built through
 * the SDK. PATH holds only the stand-ins, Bun, and the system folders.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileSha256, recordHeartbeat } from "../src/heartbeat.ts";
import { openQmd, qmdLocation } from "../src/qmd.ts";
import { executable, isolatedEnv, makeVault, scratch, TOOLS, writeFiles } from "./helpers.ts";

const SENTINEL = "---\nstatus: active\n---\n\n# llmOS\n\nShared test vault.\n";

interface Setup {
  root: string;
  bin: string;
  env: Record<string, string>;
}

async function setup(
  options: { collectionPath?: string; sentinelIndexed?: boolean } = {},
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
  symlinkSync(join(TOOLS, "bin/qmd.ts"), join(bin, "qmd"));
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
    `collections:\n  llmos:\n    path: ${options.collectionPath ?? root}\n    pattern: "**/*.md"\n`,
  );
  mkdirSync(dirname(env.INDEX_PATH as string), { recursive: true });
  const store = await openQmd(qmdLocation(env), true);
  try {
    await store.update({ collections: ["llmos"] });
  } finally {
    await store.close();
  }
  if (options.sentinelIndexed === false) writeFiles(root, { "llmOS.md": SENTINEL });
  // The plugin installed for Claude Code, and its hooks seen running.
  const plugin = join(
    env.HOME as string,
    ".claude",
    "plugins",
    "cache",
    "llmos-vault",
    "llmos",
    "1",
  );
  writeFiles(plugin, { "dist/hooks.js": "// hooks\n" });
  writeFiles(join(env.HOME as string, ".claude", "plugins"), {
    "installed_plugins.json": JSON.stringify({
      plugins: { "llmos@llmos-vault": [{ installPath: plugin }] },
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
  const result = Bun.spawnSync([process.execPath, join(TOOLS, "bin/llmos-doctor.ts")], {
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

describe("llmos-doctor", () => {
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
      "qmd-index",
      "qmd-retrieval",
      "hooks-claude",
    ]) {
      expect(result.stdout).toContain(`PASS ${check}:`);
    }
    expect(result.stdout).toContain("(qmd 2.8.3");
    expect(result.exitCode).toBe(0);
  });

  test("hooks that never ran fail with the repair", async () => {
    const { env } = await setup();
    rmSync(join(env.HOME as string, ".local", "state", "llmos", "hooks.json"));
    failed(doctor(env), "hooks-claude", "Start a fresh Claude Code session");
  });

  test("the config file is used when $LLMOS_ROOT is unset or empty", async () => {
    const { root, env } = await setup();
    const configFile = join(env.HOME as string, ".config", "llmos", "config.json");
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ vault_root: root }));
    for (const value of [undefined, ""]) {
      const next = { ...env };
      if (value === undefined) delete next.LLMOS_ROOT;
      else next.LLMOS_ROOT = value;
      const result = doctor(next);
      expect(result.stdout).toContain("PASS vault-root:");
      expect(result.exitCode).toBe(0);
    }
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

  test("an unindexed or stale sentinel fails with the reindex repair", async () => {
    const unindexed = await setup({ sentinelIndexed: false });
    failed(doctor(unindexed.env), "qmd-index", "llmos-vault reindex");

    const stale = await setup();
    writeFiles(stale.root, { "llmOS.md": `${SENTINEL}\nEdited after indexing.\n` });
    const result = doctor(stale.env);
    expect(result.stdout).toContain("PASS qmd-index:");
    failed(result, "qmd-retrieval", "llmos-vault reindex");
  });
});
