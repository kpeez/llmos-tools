/**
 * The Bash guard denies (exit 2, reason on stderr) an obsidian-cli note verb
 * without `file=`/`path=`, and a raw `mv`/`rm` of a note under a known vault
 * root. Ported from the retired Python tests `test_guard_obsidian_cli.py` and
 * `test_guard_vault_mv.py`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { checkCommand } from "../../src/hooks/guard.ts";
import {
  makeVault,
  removeTemporaryFolders,
  runHook,
  temporaryFolder,
  writeFile,
} from "./helpers.ts";

afterEach(removeTemporaryFolders);

function guard(command: string, tmp: string, options: { root?: string; cwd?: string } = {}) {
  const payload: Record<string, unknown> = { tool_input: { command } };
  if (options.cwd !== undefined) payload.cwd = options.cwd;
  return runHook("guard-bash", payload, tmp, { root: options.root });
}

function writeRegistry(home: string, vaults: Record<string, string>): void {
  const entries = Object.fromEntries(
    Object.entries(vaults).map(([key, path], index) => [key, { path, ts: index }]),
  );
  writeFile(
    join(home, "Library", "Application Support", "obsidian", "obsidian.json"),
    JSON.stringify({ vaults: entries }),
  );
}

describe("obsidian-cli targeting", () => {
  test("denies a note verb without a target and names both options", () => {
    const result = guard("obsidian-cli read", temporaryFolder());

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("file=");
    expect(result.stderr).toContain("path=");
    expect(result.stdout).toBe("");
  });

  test("denies note verbs without a target, allows them with file= or path=, and allows verbs with no target by design", () => {
    // Every note-targeting verb: a verb dropped from the guard lets an untargeted call act on the open note.
    for (const verb of [
      "read",
      "append",
      "prepend",
      "delete",
      "move",
      "rename",
      "backlinks",
      "links",
      "outline",
      "file",
      "wordcount",
      "property:read",
      "property:set",
      "property:remove",
      "diff",
      "history",
    ]) {
      expect(checkCommand(`obsidian-cli ${verb}`, "."), verb).toContain("obsidian-cli");
    }
    for (const verb of ["read", "move", "property:set"]) {
      expect(checkCommand(`obsidian-cli ${verb} file="My Note"`, ".")).toBeNull();
    }
    const result = guard('obsidian-cli read path="notes/my-note.md"', temporaryFolder());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const command of [
      "obsidian-cli vaults",
      "obsidian-cli daily:read",
      'obsidian-cli search query="term"',
      "obsidian-cli tasks",
      "obsidian-cli help read",
    ]) {
      expect(checkCommand(command, ".")).toBeNull();
    }
  });

  test("looks past a vault= prefix and into compound commands", () => {
    expect(checkCommand('obsidian-cli vault="llmOS" read', ".")).toContain("file=");
    expect(checkCommand("echo hi && obsidian-cli read", ".")).toContain("file=");
    expect(checkCommand("/opt/bin/obsidian-cli --flag outline", ".")).toContain("outline");
  });

  test("fails open on a command it cannot tokenize", () => {
    const result = guard('obsidian-cli read file="unterminated', temporaryFolder());

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("raw mv and rm on vault notes", () => {
  test("denies git mv, git rm, and rm, naming the command and the note", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const note = writeFile(join(vault, "note.md"), "# note\n");

    const gitMv = guard(`git mv ${note} ${join(vault, "b.md")}`, tmp, { root: vault });
    const gitRm = guard(`git rm ${note}`, tmp, { root: vault });
    const rm = guard(`rm -f ${note}`, tmp, { root: vault });

    expect(gitMv.exitCode).toBe(2);
    expect(gitMv.stderr).toContain("with raw git mv");
    expect(gitRm.exitCode).toBe(2);
    expect(gitRm.stderr).toContain("git rm");
    expect(gitRm.stderr).toContain(note);
    expect(rm.exitCode).toBe(2);
    expect(rm.stderr).toContain(`'rm -f ${note}' touches a vault note (${note}) with raw rm`);
  });

  test("guards a vault known only from Obsidian's registry", () => {
    const tmp = temporaryFolder();
    const notebook = makeVault(join(tmp, "notebook"));
    writeRegistry(join(tmp, "home"), { "notebook-id": notebook });
    const note = writeFile(join(notebook, "note.md"), "# note\n");

    const result = guard(`rm ${note}`, tmp);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(note);
  });

  test("catches the offending part of a compound command, glued or not", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const note = writeFile(join(vault, "note.md"), "# note\n");

    const spaced = guard(`cd /tmp && rm ${note}`, tmp, { root: vault });
    const glued = guard(`echo hi&&rm ${note}`, tmp, { root: vault });

    for (const result of [spaced, glued]) {
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(note);
    }
  });

  test("resolves a relative argument against the payload cwd", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    writeFile(join(vault, "note.md"), "# note\n");

    const result = guard("mv note.md /tmp/dest/", tmp, { root: vault, cwd: vault });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("obsidian-cli move");
  });

  test("resolves a symlinked argument to the vault note it names", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    writeFile(join(vault, "projects", "p", "note.md"), "# note\n");
    const repo = join(tmp, "repo");
    writeFile(join(repo, ".keep"), "");
    symlinkSync(join(vault, "projects", "p"), join(repo, "docs"), "dir");

    const result = guard("rm docs/note.md", tmp, { root: vault, cwd: repo });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(join(vault, "projects", "p", "note.md"));
  });

  test("fails open when no vault is configured", () => {
    const tmp = temporaryFolder();
    const note = writeFile(join(tmp, "somewhere", "note.md"), "# note\n");

    const result = guard(`rm ${note}`, tmp);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("ignores a redirection operand but not a real target before it", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const note = writeFile(join(vault, "note.md"), "# note\n");
    const old = writeFile(join(tmp, "old.txt"), "data\n");

    const redirect = guard(
      `mv ${old} ${join(tmp, "new.txt")} > ${join(vault, "notes", "log.md")}`,
      tmp,
      { root: vault },
    );
    const target = guard(`mv ${note} /tmp/dest.md > ${join(tmp, "log.txt")}`, tmp, {
      root: vault,
    });

    expect(redirect.exitCode).toBe(0);
    expect(redirect.stderr).toBe("");
    expect(target.exitCode).toBe(2);
    expect(target.stderr).toContain(note);
  });

  test("approves when the payload has no command", () => {
    const tmp = temporaryFolder();
    for (const payload of [{}, { tool_input: {} }, { tool_input: "rm x.md" }, "garbage"]) {
      const result = runHook("guard-bash", payload, tmp);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    }
  });

  test("emits Antigravity deny/allow JSON on stdout with exit 0", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const note = writeFile(join(vault, "note.md"), "# note\n");

    const denied = runHook(
      "guard-bash",
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-1",
        toolCall: { name: "run_command", args: { CommandLine: `rm ${note}` } },
      },
      tmp,
      { root: vault },
    );
    expect(denied.exitCode).toBe(0);
    expect(denied.stderr).toBe("");
    expect(JSON.parse(denied.stdout)).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining(note),
    });

    const allowed = runHook(
      "guard-bash",
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-1",
        toolCall: { name: "run_command", args: { CommandLine: "git status" } },
      },
      tmp,
      { root: vault },
    );
    expect(allowed.exitCode).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ decision: "allow" });
  });
});
