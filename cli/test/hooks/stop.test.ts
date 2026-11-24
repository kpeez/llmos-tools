/**
 * The stop hook reindexes only when a vault write left the dirty flag, and
 * clears the flag only after a successful reindex that no write overlapped.
 * Failures stay retryable and never block the turn. The flag lives only in a
 * private folder and is never followed through a symbolic link. `llmos` and
 * `qmd` are stubs on `PATH`, except in the last test, where `llmos` runs this checkout's CLI on a scratch vault and
 * index. Ported from the retired Python test `test_stop_qmd_hook.py`.
 */

import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cli, indexVault, isolatedEnv, makeVault } from "../helpers.ts";
import {
  dirtyFlag,
  makeVault as emptyVault,
  removeTemporaryFolders,
  runHook,
  temporaryFolder,
} from "./helpers.ts";

afterEach(removeTemporaryFolders);

/** A stub command that logs its name and arguments, then exits with `exitCode`. */
function stub(binDir: string, name: string, log: string, exitCode = 0): void {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $@" >> "${log}"\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
}

/** The vault of a test, made on first use. */
function vaultOf(tmp: string): string {
  const root = join(tmp, "vault");
  return existsSync(root) ? root : emptyVault(root);
}

function setFlag(tmp: string, root = vaultOf(tmp)): string {
  const flag = dirtyFlag(tmp, root);
  mkdirSync(dirname(flag), { recursive: true, mode: 0o700 });
  writeFileSync(flag, "token\n");
  return flag;
}

function stop(tmp: string, binDir?: string) {
  const path = binDir ? `${binDir}:/usr/bin:/bin` : "/usr/bin:/bin";
  return runHook("stop", { session_id: "sess-1" }, tmp, {
    root: vaultOf(tmp),
    env: { PATH: path },
  });
}

function calls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

test("runs qmd update and clears the flag when the vault is dirty and llmos is absent", () => {
  const tmp = temporaryFolder();
  const log = join(tmp, "calls.log");
  stub(join(tmp, "bin"), "qmd", log);
  const flag = setFlag(tmp);

  const result = stop(tmp, join(tmp, "bin"));

  expect(result.exitCode).toBe(0);
  expect(calls(log)).toEqual(["qmd update -c llmos"]);
  expect(existsSync(flag)).toBe(false);
});

test("prefers llmos reindex --no-embed when it is installed", () => {
  const tmp = temporaryFolder();
  const log = join(tmp, "calls.log");
  stub(join(tmp, "bin"), "llmos", log);
  stub(join(tmp, "bin"), "qmd", log);
  const flag = setFlag(tmp);

  const result = stop(tmp, join(tmp, "bin"));

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(calls(log)).toEqual(["llmos reindex --no-embed"]);
  expect(existsSync(flag)).toBe(false);
});

test("keeps the hook's stdout empty: the reindex report goes to stderr", () => {
  const tmp = temporaryFolder();
  const binDir = join(tmp, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "llmos"), "#!/bin/sh\necho '{\"update\": {}}'\n");
  chmodSync(join(binDir, "llmos"), 0o755);
  setFlag(tmp);

  const result = stop(tmp, binDir);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('{"update": {}}');
});

test("falls back to qmd update when llmos reindex fails, and says so", () => {
  const tmp = temporaryFolder();
  const log = join(tmp, "calls.log");
  stub(join(tmp, "bin"), "llmos", log, 2);
  stub(join(tmp, "bin"), "qmd", log);
  const flag = setFlag(tmp);

  const result = stop(tmp, join(tmp, "bin"));

  expect(result.exitCode).toBe(0);
  expect(calls(log)).toEqual(["llmos reindex --no-embed", "qmd update -c llmos"]);
  expect(result.stderr).toContain("llmos reindex --no-embed exited 2; ran qmd update instead");
  expect(existsSync(flag)).toBe(false);
});

test("keeps the flag when a vault write sets it again during the reindex", () => {
  const tmp = temporaryFolder();
  const binDir = join(tmp, "bin");
  mkdirSync(binDir);
  const flag = setFlag(tmp);
  writeFileSync(join(binDir, "llmos"), `#!/bin/sh\necho later > "${flag}"\n`);
  chmodSync(join(binDir, "llmos"), 0o755);

  const result = stop(tmp, binDir);

  expect(result.exitCode).toBe(0);
  expect(readFileSync(flag, "utf8")).toBe("later\n");
});

test("spawns nothing when the flag is absent", () => {
  const tmp = temporaryFolder();
  const log = join(tmp, "calls.log");
  stub(join(tmp, "bin"), "llmos", log);
  stub(join(tmp, "bin"), "qmd", log);

  const result = stop(tmp, join(tmp, "bin"));

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(calls(log)).toEqual([]);
});

test("keeps the flag and exits 0 when qmd is missing", () => {
  const tmp = temporaryFolder();
  const flag = setFlag(tmp);

  const result = stop(tmp);

  expect(result.exitCode).toBe(0);
  expect(existsSync(flag)).toBe(true);
  expect(result.stderr).toContain("qmd update failed");
  expect(result.stderr).toContain("dirty flag retained for retry");
});

test("keeps the flag and exits 0 when every reindex fails", () => {
  const tmp = temporaryFolder();
  const log = join(tmp, "calls.log");
  stub(join(tmp, "bin"), "llmos", log, 1);
  stub(join(tmp, "bin"), "qmd", log, 7);
  const flag = setFlag(tmp);

  const result = stop(tmp, join(tmp, "bin"));

  expect(result.exitCode).toBe(0);
  expect(existsSync(flag)).toBe(true);
  expect(result.stderr).toContain(
    "llmos qmd hook: llmos reindex --no-embed exited 1; qmd update exited 7; dirty flag retained for retry",
  );
});

/** A PostToolUse call for a Write of a note with frontmatter in the test's vault. */
function writeNote(tmp: string) {
  const note = join(vaultOf(tmp), "note.md");
  writeFileSync(note, "---\nstatus: draft\n---\n\n# Note\n");
  return runHook(
    "post-tool-use",
    { session_id: "sess-1", tool_name: "Write", tool_input: { file_path: note } },
    tmp,
    { root: vaultOf(tmp) },
  );
}

test("a symbolic link planted at the flag is replaced, never followed", () => {
  const tmp = temporaryFolder();
  const log = join(tmp, "calls.log");
  stub(join(tmp, "bin"), "llmos", log);
  const victim = join(tmp, "victim.txt");
  writeFileSync(victim, "precious\n");
  const flag = dirtyFlag(tmp, vaultOf(tmp));
  mkdirSync(dirname(flag), { recursive: true, mode: 0o700 });
  symlinkSync(victim, flag);

  const before = stop(tmp, join(tmp, "bin"));
  expect(before.exitCode).toBe(0);
  expect(calls(log)).toEqual([]);
  expect(writeNote(tmp).exitCode).toBe(0);
  expect(lstatSync(flag).isSymbolicLink()).toBe(false);
  const after = stop(tmp, join(tmp, "bin"));

  expect(after.exitCode).toBe(0);
  expect(calls(log)).toEqual(["llmos reindex --no-embed"]);
  expect(existsSync(flag)).toBe(false);
  expect(readFileSync(victim, "utf8")).toBe("precious\n");
});

test("a flag folder that other users can write is never used", () => {
  const tmp = temporaryFolder();
  const log = join(tmp, "calls.log");
  stub(join(tmp, "bin"), "llmos", log);
  const flag = dirtyFlag(tmp, vaultOf(tmp));
  mkdirSync(dirname(flag), { recursive: true });
  chmodSync(dirname(flag), 0o777);

  expect(writeNote(tmp).exitCode).toBe(0);
  expect(existsSync(flag)).toBe(false);
  writeFileSync(flag, "planted\n");
  const result = stop(tmp, join(tmp, "bin"));

  expect(result.exitCode).toBe(0);
  expect(calls(log)).toEqual([]);
  expect(result.stderr).toContain("is not a private folder of this user");
});

test("a memory note written outside llmos is found by memory search after the Stop hook", async () => {
  const root = makeVault({ "projects/demo/demo.md": "# demo\n" });
  const env = isolatedEnv();
  await indexVault(root, env, { llmos: "**/*.md", memory: "projects/*/memory/*.md" });
  // Claude Code writes memory notes itself; the stamp hook marks the turn dirty.
  mkdirSync(join(root, "projects/demo/memory"), { recursive: true });
  writeFileSync(
    join(root, "projects/demo/memory/heron.md"),
    "---\nname: heron\ndescription: The heron\nmetadata:\n  node_type: memory\n  type: project\n---\n\nThe heron nests by the weir.\n",
  );
  const search = async () => {
    const result = await cli(root, ["memory", "search", "weir", "--keyword", "--project", "demo"], {
      env,
    });
    return (JSON.parse(result.stdout) as { path: string }[]).map((hit) => hit.path);
  };
  expect(await search()).toEqual([]);

  const tmp = temporaryFolder();
  const binDir = join(tmp, "bin");
  mkdirSync(binDir);
  const entry = join(import.meta.dir, "..", "..", "bin", "llmos.ts");
  writeFileSync(join(binDir, "llmos"), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
  chmodSync(join(binDir, "llmos"), 0o755);
  const flag = setFlag(tmp, root);
  const result = runHook("stop", { session_id: "sess-1" }, tmp, {
    root,
    env: { ...env, HOME: join(tmp, "home"), PATH: `${binDir}:/usr/bin:/bin` },
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(flag)).toBe(false);
  expect(await search()).toEqual(["projects/demo/memory/heron.md"]);
});
