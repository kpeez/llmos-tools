/**
 * The after-shell check reads the vault, not the command, so it reports a
 * removal in any form the guard cannot parse. The test removes a note with
 * the filesystem between two hook runs, as the shell command would.
 */

import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  additionalContext,
  makeVault,
  removeTemporaryFolders,
  runHook,
  temporaryFolder,
  writeFile,
} from "./helpers.ts";

afterEach(removeTemporaryFolders);

function vaultWithNotes(): { tmp: string; root: string } {
  const tmp = temporaryFolder();
  const root = makeVault(join(tmp, "vault"));
  writeFile(join(root, "notes", "n.md"), "# n\n");
  writeFile(join(root, "notes", "keep.md"), "# keep\n");
  return { tmp, root };
}

const session = { session_id: "s1", cwd: "/" };
const shell = (command: string) => ({
  ...session,
  tool_name: "Bash",
  tool_input: { command },
});

test("a note removed by a form the guard cannot parse is named, with the undo", () => {
  const { tmp, root } = vaultWithNotes();
  runHook("session-start", session, tmp, { root });
  rmSync(join(root, "notes", "n.md"));
  const command = "find . -name 'n.md' -delete";
  const result = runHook("post-shell", shell(command), tmp, { root });
  const text = additionalContext(result, "PostToolUse");
  expect(text).toContain("- notes/n.md");
  expect(text).not.toContain("notes/keep.md");
  expect(text).toContain("git -C");
  expect(text).toContain("obsidian-cli move");
  expect(runHook("post-shell", shell("ls"), tmp, { root }).stdout).toBe("");
});

test("a move shows the new path, and an obsidian-cli command that names the note is not reported", () => {
  const { tmp, root } = vaultWithNotes();
  runHook("session-start", session, tmp, { root });
  rmSync(join(root, "notes", "n.md"));
  writeFile(join(root, "archive", "n.md"), "# n\n");
  const moved = runHook("post-shell", shell("bash -c 'mv notes/n.md archive/'"), tmp, { root });
  expect(additionalContext(moved, "PostToolUse")).toContain("- notes/n.md (now at archive/n.md)");

  rmSync(join(root, "notes", "keep.md"));
  const tooled = runHook("post-shell", shell("obsidian-cli delete file=keep"), tmp, { root });
  expect(tooled.stdout).toBe("");
});

test("a session with no saved list reports nothing and starts one", () => {
  const { tmp, root } = vaultWithNotes();
  rmSync(join(root, "notes", "n.md"));
  expect(runHook("post-shell", shell("ls"), tmp, { root }).stdout).toBe("");
  rmSync(join(root, "notes", "keep.md"));
  const result = runHook("post-shell", shell("ls"), tmp, { root });
  expect(additionalContext(result, "PostToolUse")).toContain("- notes/keep.md");
});

test("Antigravity gets the report with its next tool call, once", () => {
  const { tmp, root } = vaultWithNotes();
  const agy = (extra: object) => ({
    hookEventName: "PostToolUse",
    conversationId: "c1",
    workspacePaths: [root],
    cwd: root,
    ...extra,
  });
  runHook("session-start", agy({}), tmp, { root });
  rmSync(join(root, "notes", "n.md"));
  const post = runHook(
    "post-shell",
    agy({ toolCall: { name: "run_command", args: { CommandLine: "rm -f notes/n.md" } } }),
    tmp,
    { root },
  );
  expect(JSON.parse(post.stdout)).toEqual({});
  const next = agy({
    hookEventName: "PreToolUse",
    toolCall: { name: "read_file", args: { path: join(root, "AGENTS.md") } },
  });
  expect(JSON.parse(runHook("pre-tool-use", next, tmp, { root }).stdout).reason).toContain(
    "- notes/n.md",
  );
  expect(
    JSON.parse(runHook("pre-tool-use", next, tmp, { root }).stdout).reason ?? "",
  ).not.toContain("notes/n.md");
});
