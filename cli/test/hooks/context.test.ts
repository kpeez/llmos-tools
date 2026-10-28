/**
 * The session-start and pre-tool-use hooks gate on paths, not on intent,
 * and never read provider memory (ADR-0003). Ported from
 * the retired Python test `test_hook_gating.py`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileSha256 } from "../../src/heartbeat.ts";
import {
  additionalContext,
  BUNDLE,
  makeVault,
  removeTemporaryFolders,
  runHook,
  temporaryFolder,
  todayIso,
  writeFile,
} from "./helpers.ts";

const MEMORY_SENTINEL = "MEMORY-SENTINEL-DO-NOT-LEAK";
const SCHEMA_SENTINEL = "SCHEMA-CONTRACT-SENTINEL";
const AUTHORING_SENTINEL = "OBSIDIAN-AUTHORING-CONTRACT-SENTINEL";

afterEach(removeTemporaryFolders);

/** A vault with the schema and authoring references and a provider MEMORY.md. */
function contextVault(root: string): string {
  makeVault(root);
  writeFile(join(root, "schema.md"), `${SCHEMA_SENTINEL}\n`);
  writeFile(
    join(root, "authoring.md"),
    `${AUTHORING_SENTINEL}\nUse [[wikilinks]], Bases, and Canvas where useful.\n`,
  );
  writeFile(join(root, "agents", "claude", "MEMORY.md"), `${MEMORY_SENTINEL}\n`);
  return root;
}

/** A repository whose `<dot>/docs` symlink leads to `target`. */
function linkedRepo(repo: string, target: string, dot = ".agents"): string {
  mkdirSync(join(repo, dot), { recursive: true });
  symlinkSync(target, join(repo, dot, "docs"), "dir");
  return repo;
}

function applyPatch(...lines: string[]) {
  const body = ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
  return { tool_name: "apply_patch", tool_input: { command: body } };
}

describe("session-start", () => {
  test("is silent outside the vault", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const outside = join(tmp, "elsewhere");
    mkdirSync(outside);

    const result = runHook("session-start", { cwd: outside }, tmp, { root: vault });

    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("adds the root and the daily note's absolute path as bare stdout inside the vault", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));

    const result = runHook("session-start", { cwd: vault }, tmp, { root: vault });

    expect(result.stdout).toContain(vault);
    expect(result.stdout.toLowerCase()).toContain("thoughts");
    expect(result.stdout).toContain(join(vault, "daily", `${todayIso()}.md`));
    // Agents see only the deferred MCP tool names, so the context names them.
    expect(result.stdout).toContain("llmos MCP server");
    expect(result.stdout).toContain("daily_append_thought");
    expect(result.stdout).not.toContain("hookSpecificOutput");
    expect(result.stdout).not.toContain(MEMORY_SENTINEL);
    expect(result.exitCode).toBe(0);
  });

  test("routes a repository with a linked docs folder to the vault", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const projectDocs = join(vault, "projects", "testproj");
    mkdirSync(projectDocs, { recursive: true });
    const repo = linkedRepo(join(tmp, "repo"), projectDocs);
    const nested = join(repo, "src", "tests");
    mkdirSync(nested, { recursive: true });

    const result = runHook("session-start", { cwd: nested }, tmp, { root: vault });

    expect(result.stdout).toContain(vault);
    expect(result.stdout).toContain(
      `${join(repo, ".agents", "docs")} (resolves to ${projectDocs})`,
    );
    expect(result.stdout).toContain("authoring.md");
    expect(result.exitCode).toBe(0);
  });

  test("records a heartbeat per agent, even outside the vault", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const claudeRoot = join(
      tmp,
      "home",
      ".claude",
      "plugins",
      "cache",
      "llmos-vault",
      "llmos",
      "1",
    );
    const codexRoot = join(tmp, "home", ".codex", "plugins", "cache", "llmos-vault", "llmos", "1");

    const claude = runHook("session-start", { cwd: vault }, tmp, {
      root: vault,
      script: BUNDLE,
      env: { CLAUDE_PLUGIN_ROOT: claudeRoot },
    });
    // A Codex started from a Claude shell inherits CLAUDECODE; the plugin root decides.
    const codex = runHook("session-start", { cwd: tmp }, tmp, {
      root: vault,
      script: BUNDLE,
      env: { CLAUDE_PLUGIN_ROOT: codexRoot, CLAUDECODE: "1" },
    });

    expect(claude.exitCode).toBe(0);
    expect(claude.stdout).toContain(`llmOS root: ${vault}.`);
    expect(codex.stdout).toBe("");
    const beats = JSON.parse(
      readFileSync(join(tmp, "home", ".local", "state", "llmos", "hooks.json"), "utf8"),
    );
    expect(Object.keys(beats).sort()).toEqual(["claude", "codex"]);
    expect(beats.claude).toMatchObject({
      bun: Bun.version,
      bundleSha256: fileSha256(BUNDLE),
      pluginRoot: claudeRoot,
    });
    expect(Date.now() - Date.parse(beats.codex.time)).toBeLessThan(60_000);
  });

  test("a heartbeat that cannot be written changes nothing", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const expected = runHook("session-start", { cwd: vault }, tmp, { root: vault });
    const blocked = temporaryFolder();
    // The state folder is a file, so the heartbeat's folder cannot be made.
    writeFile(join(blocked, "home", ".local", "state"), "not a folder");

    const result = runHook("session-start", { cwd: vault }, blocked, { root: vault });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expected.stdout);
  });
});

describe("pre-tool-use", () => {
  test("adds the schema and authoring contract before a write through a symlinked folder", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const projectDocs = join(vault, "projects", "testproj");
    writeFile(join(projectDocs, "specs", "foo.md"), "# spec\n");
    // The repository's docs/agents symlink points out of the repository, into the vault.
    const repo = join(tmp, "agent-toolbox");
    mkdirSync(join(repo, "docs"), { recursive: true });
    symlinkSync(projectDocs, join(repo, "docs", "agents"), "dir");

    const result = runHook(
      "pre-tool-use",
      { tool_input: { file_path: join(repo, "docs", "agents", "specs", "foo.md") } },
      tmp,
      { root: vault },
    );

    const context = additionalContext(result, "PreToolUse");
    expect(context).toContain(SCHEMA_SENTINEL);
    expect(context).toContain(AUTHORING_SENTINEL);
    expect(context).toContain("obsidian-markdown");
    expect(result.exitCode).toBe(0);
  });

  test("adds retrieval guidance, not the schema, before a read through a linked folder", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const projectDocs = join(vault, "projects", "testproj");
    writeFile(join(projectDocs, "note.md"), "# Note\n");
    const repo = linkedRepo(join(tmp, "repo"), projectDocs, ".agent");

    const result = runHook(
      "pre-tool-use",
      { tool_name: "Read", tool_input: { file_path: join(repo, ".agent", "docs", "note.md") } },
      tmp,
      { root: vault },
    );

    const context = additionalContext(result, "PreToolUse");
    expect(context).toContain("Obsidian vault note");
    expect(context).toContain("authoring.md");
    expect(context).toContain("llmos-vault read");
    expect(context).toContain("qmd");
    expect(context).not.toContain(SCHEMA_SENTINEL);
    expect(result.exitCode).toBe(0);
  });

  test("routes a canvas write to json-canvas without the note schema", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const canvas = writeFile(
      join(vault, "projects", "testproj", "map.canvas"),
      '{"nodes": [], "edges": []}\n',
    );

    const result = runHook(
      "pre-tool-use",
      { tool_name: "Write", tool_input: { file_path: canvas } },
      tmp,
      { root: vault },
    );

    const context = additionalContext(result, "PreToolUse");
    expect(context).toContain(AUTHORING_SENTINEL);
    expect(context).toContain("json-canvas");
    expect(context).not.toContain(SCHEMA_SENTINEL);
  });

  test("recognizes a simple shell read of a linked path", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const projectDocs = join(vault, "projects", "testproj");
    writeFile(join(projectDocs, "note.md"), "# Note\n");
    const repo = linkedRepo(join(tmp, "repo"), projectDocs);

    const result = runHook(
      "pre-tool-use",
      {
        tool_name: "Bash",
        tool_input: { command: `cat ${join(repo, ".agents", "docs", "note.md")}` },
      },
      tmp,
      { root: vault },
    );

    const context = additionalContext(result, "PreToolUse");
    expect(context).toContain("Obsidian vault note");
    expect(context).toContain("authoring.md");
  });

  test("recognizes an llmos-vault read with --vault=llmos and ignores other vaults", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));

    const llmos = runHook(
      "pre-tool-use",
      {
        tool_name: "Bash",
        tool_input: { command: "llmos-vault neighbors projects/testproj --vault=llmos" },
      },
      tmp,
      { root: vault },
    );
    const second-vault = runHook(
      "pre-tool-use",
      { tool_name: "Bash", tool_input: { command: "llmos-vault read note --vault second-vault" } },
      tmp,
      { root: vault },
    );

    expect(additionalContext(llmos, "PreToolUse")).toContain("Obsidian vault note");
    expect(second-vault.stdout).toBe("");
    expect(second-vault.exitCode).toBe(0);
  });

  test("ignores compound shell commands", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const note = writeFile(join(vault, "note.md"), "# Note\n");

    const result = runHook(
      "pre-tool-use",
      { tool_name: "Bash", tool_input: { command: `cat ${note} | head` } },
      tmp,
      { root: vault },
    );

    expect(result.stdout).toBe("");
  });

  test("anchors a relative path at the payload cwd", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const projectDocs = join(vault, "projects", "testproj");
    writeFile(join(projectDocs, "note.md"), "# Note\n");
    const repo = linkedRepo(join(tmp, "repo"), projectDocs);

    const result = runHook(
      "pre-tool-use",
      { cwd: repo, tool_name: "Read", tool_input: { file_path: ".agents/docs/note.md" } },
      tmp,
      { root: vault },
    );

    expect(additionalContext(result, "PreToolUse")).toContain("Obsidian vault note");
  });

  test("is silent for a target outside the vault", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const other = writeFile(join(tmp, "other-repo", "src", "main.py"), "print('hi')\n");

    const result = runHook("pre-tool-use", { tool_input: { file_path: other } }, tmp, {
      root: vault,
    });

    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("reads Codex apply_patch targets: update, add, and a path relative to the cwd", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const spec = writeFile(join(vault, "projects", "testproj", "specs", "foo.md"), "# spec\n");
    const added = join(vault, "projects", "testproj", "specs", "0001-new.md");

    const update = runHook(
      "pre-tool-use",
      applyPatch(`*** Update File: ${spec}`, "@@", "-a", "+b"),
      tmp,
      { root: vault },
    );
    const add = runHook("pre-tool-use", applyPatch(`*** Add File: ${added}`, "+# new"), tmp, {
      root: vault,
    });
    const relative = runHook(
      "pre-tool-use",
      applyPatch("*** Update File: specs/foo.md", "@@", "-a", "+b"),
      tmp,
      { root: vault, cwd: join(vault, "projects", "testproj") },
    );

    for (const result of [update, add, relative]) {
      expect(additionalContext(result, "PreToolUse")).toContain(SCHEMA_SENTINEL);
      expect(result.exitCode).toBe(0);
    }
  });

  test("adds the schema and authoring contract before an llmOS MCP write tool", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    // Claude Code's and Codex's names for the plugin server's tools; the
    // committed bundle is what the harnesses run.
    for (const [toolName, script] of [
      ["mcp__plugin_llmos_llmos__daily_append_thought", undefined],
      ["mcp__llmos__set_property", BUNDLE],
      ["mcp__plugin_llmos_llmos__file_inbox", BUNDLE],
    ] as const) {
      const payload = { tool_name: toolName, tool_input: { text: "A thought." }, cwd: tmp };
      const result = runHook("pre-tool-use", payload, tmp, { root: vault, script });
      const context = additionalContext(result, "PreToolUse");
      expect(context).toContain(SCHEMA_SENTINEL);
      expect(context).toContain(AUTHORING_SENTINEL);
      expect(context).toContain("obsidian-markdown");
      expect(result.exitCode).toBe(0);
    }
  });

  test("is silent for the MCP read tools and for other servers' tools", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    for (const toolName of [
      "mcp__plugin_llmos_llmos__read",
      "mcp__llmos__search",
      "mcp__other__set_property",
      "mcp__plugin_other_llmos__set_property",
    ]) {
      const payload = { tool_name: toolName, tool_input: { note: "alpha" } };
      const result = runHook("pre-tool-use", payload, tmp, { root: vault });
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });

  test("injects only through hookSpecificOutput, the channel the model reads", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    const spec = writeFile(join(vault, "projects", "testproj", "specs", "foo.md"), "# spec\n");

    const result = runHook("pre-tool-use", { tool_input: { file_path: spec } }, tmp, {
      root: vault,
    });

    const output = JSON.parse(result.stdout);
    expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain(SCHEMA_SENTINEL);
  });

  test("truncates long authoring guidance", () => {
    const tmp = temporaryFolder();
    const vault = contextVault(join(tmp, "vault"));
    writeFile(join(vault, "authoring.md"), `${"é".repeat(9000)}\n`);
    const note = writeFile(join(vault, "note.md"), "# Note\n");

    const result = runHook(
      "pre-tool-use",
      { tool_name: "Edit", tool_input: { file_path: note } },
      tmp,
      { root: vault },
    );

    const context = additionalContext(result, "PreToolUse");
    expect(context).toContain(`${"é".repeat(8000)}\n[authoring guidance truncated]`);
    expect(context).not.toContain("é".repeat(8001));
  });

  test("stays silent and exits 0 when no vault is configured or the payload is malformed", () => {
    const tmp = temporaryFolder();
    const target = writeFile(join(tmp, "some-other-repo", "src", "main.py"), "print('hi')\n");
    const vault = contextVault(join(tmp, "vault"));

    const unconfigured = runHook("pre-tool-use", { tool_input: { file_path: target } }, tmp);
    const notJson = runHook("pre-tool-use", "not json", tmp, { root: vault });
    const wrongShape = runHook("pre-tool-use", { tool_input: "x" }, tmp, { root: vault });
    const unknownEvent = runHook("no-such-event", {}, tmp, { root: vault });

    for (const result of [unconfigured, notJson, wrongShape, unknownEvent]) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });
});
