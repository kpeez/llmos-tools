/**
 * The post-tool-use hook normalizes vault notes, stamps `updated`, flags the qmd collection dirty, and
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
  test("writes the canonical form with updated", () => {
    const { tmp, vault, note } = setup(MESSY_NOTE);

    const result = stamp(note, tmp, vault);

    expect(result.exitCode).toBe(0);
    // The same bytes the retired Python hook wrote for this note.
    expect(readFileSync(note, "utf8")).toBe(
      "---\ncategories:\n" +
        `  - "[[Knowledge]]"\ncreated: 2026-07-01\nupdated: ${todayIso()}\n---\n\n` +
        "# A note\n\nBody content, with a wikilink to [[Some Other Note]].\n",
    );
    expect(existsSync(dirtyFlag(tmp, vault))).toBe(true);
    // No authoring findings: the hook stays silent.
    expect(result.stdout).toBe("");
  });

  test("a second stamp changes nothing", () => {
    const { tmp, vault, note } = setup(MESSY_NOTE);

    stamp(note, tmp, vault);
    const once = readFileSync(note, "utf8");
    stamp(note, tmp, vault);

    expect(readFileSync(note, "utf8")).toBe(once);
  });

  test("keeps the file mode", () => {
    const { tmp, vault, note } = setup(MESSY_NOTE);
    chmodSync(note, 0o640);

    stamp(note, tmp, vault);

    const text = readFileSync(note, "utf8");
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
    expect(existsSync(dirtyFlag(tmp, vault))).toBe(true);
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
    expect(existsSync(dirtyFlag(tmp, vault))).toBe(true);
  });

  test("a write outside the vault", () => {
    const { tmp, vault } = setup(MESSY_NOTE);
    const outside = writeFile(join(tmp, "other-repo", "README.md"), "# hello\n");

    stamp(outside, tmp, vault);

    expect(readFileSync(outside, "utf8")).toBe("# hello\n");
    expect(existsSync(dirtyFlag(tmp, vault))).toBe(false);
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
    expect(existsSync(dirtyFlag(tmp, vault))).toBe(false);
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
        "Run `llmos check <note>` for complete findings.",
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

describe("frontmatter that does not parse", () => {
  const BROKEN =
    "---\ncreated: 2026-07-01\ndescription: Rule: quote values with colons\n---\n# T\n";
  const FINDING =
    "[invalid-frontmatter]: Frontmatter does not parse at line 2, column 14 of the block " +
    "(Nested mappings are not allowed in compact mappings). " +
    'Often an unquoted value that contains ": ": double-quote it, for example description: "Rule: quote it".';

  test("a durable note gets a finding with the parser's position and a fix hint, and stays unchanged", () => {
    const { tmp, vault, note } = setup(BROKEN, "broken.md");

    const result = stamp(note, tmp, vault);

    expect(additionalContext(result, "PostToolUse")).toContain(`broken.md:3 ${FINDING}`);
    expect(readFileSync(note, "utf8")).toBe(BROKEN);
    expect(result.exitCode).toBe(0);
  });

  test("a shared memory note gets the same finding and stays unchanged", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const path = "projects/testproj/memory/topic.md";
    const note = writeFile(join(vault, path), BROKEN);

    const result = stamp(note, tmp, vault);

    expect(additionalContext(result, "PostToolUse")).toContain(`${path}:3 ${FINDING}`);
    expect(readFileSync(note, "utf8")).toBe(BROKEN);
    expect(result.exitCode).toBe(0);
  });
});

describe("shared project memory and Antigravity hooks", () => {
  test("adds metadata.node_type to a memory note without one, and leaves MEMORY.md alone", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const memory = join(vault, "projects", "testproj", "memory");
    const topic = writeFile(
      join(memory, "topic.md"),
      "---\nname: Topic\ndescription: From another agent\nmetadata:\n  type: user\n---\n\nBody.\n",
    );
    const indexText = "# Memory index\n\n- [Topic](topic.md) — hook\n";
    const index = writeFile(join(memory, "MEMORY.md"), indexText);

    const result = runHook(
      "post-tool-use",
      { session_id: "sess-mem-type", tool_name: "Write", tool_input: { file_path: topic } },
      tmp,
      { root: vault, env: { CLAUDECODE: "1" } },
    );
    const indexResult = runHook(
      "post-tool-use",
      { session_id: "sess-mem-type", tool_name: "Write", tool_input: { file_path: index } },
      tmp,
      { root: vault, env: { CLAUDECODE: "1" } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(indexResult.exitCode).toBe(0);
    const stamped = readFileSync(topic, "utf8");
    expect(stamped).toContain("metadata:\n  node_type: memory\n  type: user\n");
    expect(stamped).toContain("description: From another agent\n");
    expect(stamped).not.toContain("updated:");
    expect(stamped.endsWith("\nBody.\n")).toBe(true);
    expect(readFileSync(index, "utf8")).toBe(indexText);
  });

  test("keeps comments and quoted values when it adds node_type, and skips non-map metadata", () => {
    const tmp = temporaryFolder();
    const vault = makeVault(join(tmp, "vault"));
    const memory = join(vault, "projects", "testproj", "memory");
    const topic = writeFile(
      join(memory, "quoted.md"),
      '---\n# keep me\nname: "3"\ndescription: Flags\nmetadata:\n  type: user # inline\n  count: "true"\n---\n\nBody.\n',
    );
    const scalarText =
      "---\nname: Odd\ndescription: Scalar metadata\nmetadata: user\n---\n\nBody.\n";
    const scalar = writeFile(join(memory, "scalar.md"), scalarText);

    for (const file of [topic, scalar]) {
      const result = runHook(
        "post-tool-use",
        { session_id: "sess-mem-keep", tool_name: "Write", tool_input: { file_path: file } },
        tmp,
        { root: vault, env: { CLAUDECODE: "1" } },
      );
      expect(result.exitCode).toBe(0);
    }
    const stamped = readFileSync(topic, "utf8");
    expect(stamped).toContain("# keep me\n");
    expect(stamped).toContain('name: "3"\n');
    expect(stamped).toContain("node_type: memory\n");
    expect(stamped).toContain("type: user # inline\n");
    expect(stamped).toContain('count: "true"\n');
    expect(readFileSync(scalar, "utf8")).toBe(scalarText);
  });

  test("leaves a memory note that has node_type unchanged and unchecked, while flagging qmd dirty", () => {
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
    expect(existsSync(dirtyFlag(tmp, vault))).toBe(true);
  });

  test("Antigravity post-tool-use stamps durable notes and emits {} on post-tool-use and stop", () => {
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
    expect(readFileSync(note, "utf8")).toContain(`updated: ${todayIso()}\n`);
    expect(existsSync(dirtyFlag(tmp, vault))).toBe(true);

    const stopRes = runHook("stop", { hookEventName: "Stop", conversationId: "conv-agy" }, tmp, {
      root: vault,
      env: { ANTIGRAVITY_CLI: "1" },
    });
    expect(stopRes.exitCode).toBe(0);
    expect(JSON.parse(stopRes.stdout)).toEqual({});
  });
});
