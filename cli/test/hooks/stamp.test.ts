/**
 * The post-tool-use hook normalizes vault notes, stamps `updated`, appends
 * the provider to `authors` once, flags the qmd collection dirty, and
 * reports authoring findings. Notes it cannot rewrite safely stay byte for
 * byte. Ported from the retired Python test `test_stamp_format.py`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { checkNote } from "../../src/authoring.ts";
import { type Note, VaultModel } from "../../src/vault.ts";
import {
  additionalContext,
  dirtyFlag,
  makeVault,
  removeTemporaryFolders,
  runHook,
  temporaryFolder,
  todayIso,
  writeFile,
} from "./helpers.ts";

const MESSY_NOTE =
  "---\n" +
  "created: 2026-07-01\n" +
  "categories:\n" +
  '  - "[[Knowledge]]"\n' +
  "---\n" +
  "# A note\n" +
  "\n" +
  "Body content, with a wikilink to [[Some Other Note]].\n";

afterEach(removeTemporaryFolders);

function stamp(note: string, tmp: string, root: string, env: Record<string, string> = {}) {
  return runHook("post-tool-use", { session_id: "sess-1", tool_input: { file_path: note } }, tmp, {
    root,
    env,
  });
}

function setup(text: string, name = "note.md") {
  const tmp = temporaryFolder();
  const vault = makeVault(join(tmp, "vault"));
  const note = writeFile(join(vault, name), text);
  return { tmp, vault, note };
}

describe("stamping", () => {
  test("writes the canonical form with updated and the provider in authors", () => {
    const { tmp, vault, note } = setup(MESSY_NOTE);

    const result = stamp(note, tmp, vault, { CLAUDECODE: "1" });

    expect(result.exitCode).toBe(0);
    // The same bytes the retired Python hook wrote for this note.
    expect(readFileSync(note, "utf8")).toBe(
      "---\nauthors:\n  - claude\ncategories:\n" +
        `  - "[[Knowledge]]"\ncreated: 2026-07-01\nupdated: ${todayIso()}\n---\n\n` +
        "# A note\n\nBody content, with a wikilink to [[Some Other Note]].\n",
    );
    expect(existsSync(dirtyFlag(tmp, "sess-1"))).toBe(true);
    // No authoring findings: the hook stays silent.
    expect(result.stdout).toBe("");
  });

  test("appends the provider once, so a second stamp changes nothing", () => {
    const { tmp, vault, note } = setup(MESSY_NOTE);

    stamp(note, tmp, vault, { CODEX_SANDBOX_NETWORK_DISABLED: "1" });
    const once = readFileSync(note, "utf8");
    stamp(note, tmp, vault, { CODEX_SANDBOX_NETWORK_DISABLED: "1" });

    expect(readFileSync(note, "utf8")).toBe(once);
    expect(once.match(/codex/g)).toHaveLength(1);
  });

  test("leaves authors alone when no provider is detected, and keeps the file mode", () => {
    const { tmp, vault, note } = setup(MESSY_NOTE);
    chmodSync(note, 0o640);

    stamp(note, tmp, vault);

    const text = readFileSync(note, "utf8");
    expect(text).not.toContain("authors");
    expect(text).toContain("created: 2026-07-01");
    expect(statSync(note).mode & 0o777).toBe(0o640);
  });

  test("rewrites the note in place, keeping the same file", () => {
    const { tmp, vault, note } = setup(MESSY_NOTE);
    const before = statSync(note);

    stamp(note, tmp, vault);

    const after = statSync(note);
    expect(after.ino).toBe(before.ino);
    expect(after.birthtimeMs).toBe(before.birthtimeMs);
  });
});

describe("notes left unchanged", () => {
  test.each([
    ["no frontmatter block", "# Just a note\n\nNo frontmatter here.\n"],
    ["YAML errors", "---\ntitle: [unclosed\n---\n\nBody\n"],
  ])("a note with %s", (_label, original) => {
    const { tmp, vault, note } = setup(original);

    const result = stamp(note, tmp, vault, { CLAUDECODE: "1" });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(note, "utf8")).toBe(original);
    expect(existsSync(dirtyFlag(tmp, "sess-1"))).toBe(false);
  });

  test("a note that is not valid UTF-8", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const note = join(vault, "binary.md");
    const bytes = Buffer.concat([
      Buffer.from("---\ntitle: caf"),
      Buffer.from([0xe9]),
      Buffer.from("\n---\n\nBody\n"),
    ]);
    writeFileSync(note, bytes);

    const result = stamp(note, tmp, vault, { CLAUDECODE: "1" });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(note).equals(bytes)).toBe(true);
    expect(existsSync(dirtyFlag(tmp, "sess-1"))).toBe(false);
  });

  test("a write outside the vault", () => {
    const { tmp, vault } = setup(MESSY_NOTE);
    const outside = writeFile(join(tmp, "other-repo", "README.md"), "# hello\n");

    stamp(outside, tmp, vault);

    expect(readFileSync(outside, "utf8")).toBe("# hello\n");
    expect(existsSync(dirtyFlag(tmp, "sess-1"))).toBe(false);
  });

  test("Bases and Canvas files", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    for (const [suffix, original] of [
      [".base", "filters:\n  and: []\n"],
      [".canvas", '{"nodes": [], "edges": []}\n'],
    ] as const) {
      const file = writeFile(join(vault, `map${suffix}`), original);

      const result = stamp(file, tmp, vault);

      expect(result.exitCode).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(original);
    }
    expect(existsSync(dirtyFlag(tmp, "sess-1"))).toBe(false);
  });

  test("any note when no vault is configured", () => {
    const tmp = temporaryFolder();
    const note = writeFile(join(tmp, "some-repo", "note.md"), MESSY_NOTE);

    const result = runHook(
      "post-tool-use",
      { session_id: "sess-1", tool_input: { file_path: note } },
      tmp,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(note, "utf8")).toBe(MESSY_NOTE);
  });
});

describe("authoring findings", () => {
  test("reports an unlinked reference to an existing note as PostToolUse context", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    writeFile(join(vault, "projects", "testproj", "target.md"), "# Target\n");
    const note = writeFile(
      join(vault, "projects", "testproj", "source.md"),
      "---\ncreated: 2026-07-01\n---\n# Source\n\nSee target.md for the explanation.\n",
    );

    const result = stamp(note, tmp, vault);

    const context = additionalContext(result, "PostToolUse");
    expect(context).toBe(
      "llmOS authoring check (informational; this checker did not block the write or " +
        "rewrite note content):\n" +
        "projects/testproj/source.md:8 [unlinked-note] -> projects/testproj/target: " +
        'Existing note reference "target.md": link to "projects/testproj/target" using the ' +
        "note title or a natural phrase, not the filename.\n" +
        "Run `llmos-vault check <note>` for complete findings.",
    );
    expect(readFileSync(note, "utf8")).toContain("See target.md for the explanation.");
    expect(result.exitCode).toBe(0);
  });

  test("reports a Markdown defect in a note that mentions no .md file", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const note = writeFile(join(vault, "plain.md"), "# Plain\n\nSee [the paper]().\n");

    const result = stamp(note, tmp, vault);

    expect(additionalContext(result, "PostToolUse")).toContain("plain.md:3 [empty-link]");
  });

  test("matches the full-vault check: folder symlinks are not indexed, cycles do not hang", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    writeFile(join(vault, "a", "x.md"), "# X\n");
    writeFile(join(vault, "a", "Dup.md"), "# Dup\n");
    writeFile(join(vault, "b", "dup.md"), "# dup\n");
    writeFile(join(vault, "c", "y.md"), "# Y\n");
    symlinkSync(join(vault, "c", "y.md"), join(vault, "alias.md"));
    writeFile(join(tmp, "outside", "o.md"), "# O\n");
    symlinkSync(join(vault, "a"), join(vault, "mirror"));
    symlinkSync(join(tmp, "outside"), join(vault, "ext"));
    mkdirSync(join(vault, "sub"));
    symlinkSync("..", join(vault, "sub", "up"));
    symlinkSync("..", join(vault, "sub", "up2"));
    const note = writeFile(
      join(vault, "n.md"),
      "---\ncreated: 2026-07-01\n---\n\nSee x.md, o.md, dup.md, and alias.md here.\n",
    );

    const started = performance.now();
    const result = stamp(note, tmp, vault);
    const elapsed = performance.now() - started;

    const model = VaultModel.load(vault);
    const check = checkNote(model, model.notes.find((n) => n.path === "n.md") as Note);
    const expected = check.findings.map((f) => `n.md:${f.line} [${f.code}] -> ${f.target}: `);
    const lines = additionalContext(result, "PostToolUse").split("\n").slice(1, -1);
    expect(lines.map((line) => line.slice(0, line.indexOf(": ") + 2))).toEqual(expected);
    expect(expected.map((line) => line.split(" -> ")[1])).toEqual(["a/x: ", "c/y: "]);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("shared project memory and Antigravity hooks", () => {
  test("never stamps or checks memory notes, while still flagging qmd dirty", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const memContent =
      "---\nname: Topic\ndescription: Kept intact\nmetadata:\n  node_type: memory\n  type: project\n---\n\nSee plain-ref.md and [[unresolved]].\n";
    const topic = writeFile(join(vault, "projects", "testproj", "memory", "topic.md"), memContent);

    const result = runHook(
      "post-tool-use",
      { session_id: "sess-mem", tool_name: "Write", tool_input: { file_path: topic } },
      tmp,
      { root: vault, env: { CLAUDECODE: "1" } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(topic, "utf8")).toBe(memContent);
    expect(existsSync(dirtyFlag(tmp, "sess-mem"))).toBe(true);
  });

  test("Antigravity post-tool-use stamps durable notes with gemini and emits {} on post-tool-use and stop", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const note = writeFile(join(vault, "note.md"), MESSY_NOTE);

    const post = runHook(
      "post-tool-use",
      {
        hookEventName: "PostToolUse",
        conversationId: "conv-agy",
        toolCall: { name: "write_file", args: { TargetFile: note } },
      },
      tmp,
      { root: vault, env: { ANTIGRAVITY_CLI: "1" } },
    );
    expect(post.exitCode).toBe(0);
    expect(JSON.parse(post.stdout)).toEqual({});
    expect(readFileSync(note, "utf8")).toContain("authors:\n  - gemini\n");
    expect(existsSync(dirtyFlag(tmp, "conv-agy"))).toBe(true);

    const stopRes = runHook("stop", { hookEventName: "Stop", conversationId: "conv-agy" }, tmp, {
      root: vault,
      env: { ANTIGRAVITY_CLI: "1" },
    });
    expect(stopRes.exitCode).toBe(0);
    expect(JSON.parse(stopRes.stdout)).toEqual({});
  });
});
