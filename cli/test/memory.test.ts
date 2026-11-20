/**
 * Shared project memory through the `llmos memory` verbs, on temporary
 * vaults and an isolated qmd index (keyword search needs no model).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openQmd, qmdLocation } from "../src/qmd.ts";
import { cli, isolatedEnv, makeVault, read, scratch, writeFiles } from "./helpers.ts";

const PROJECTS = {
  "projects/my-repo/my-repo.md": "# my-repo\n",
  "projects/personal/personal.md": "# personal\n",
};

function vault(files: Record<string, string> = {}): string {
  return makeVault({ ...PROJECTS, ...files });
}

async function json(root: string, argv: string[], env = isolatedEnv()): Promise<unknown> {
  const result = await cli(root, argv, { env });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function gitRepo(name: string): string {
  const repo = join(scratch("repo"), name);
  mkdirSync(repo, { recursive: true });
  const init = Bun.spawnSync({ cmd: ["git", "init", "--quiet", repo] });
  if (init.exitCode !== 0) throw new Error("git init failed");
  return repo;
}

const save = (name: string, ...rest: string[]) => [
  "memory",
  "save",
  name,
  `When ${name} matters`,
  `The ${name} fact.`,
  "--project",
  "my-repo",
  ...rest,
];

describe("memory scope", () => {
  test("a repository named like a vault project uses that project's memory", async () => {
    const root = vault();
    const repo = gitRepo("my-repo");
    mkdirSync(join(repo, "src"));
    const scope = await json(root, ["memory", "scope", "--workspace", join(repo, "src")]);
    expect(scope).toEqual({
      project: "my-repo",
      dir: "projects/my-repo/memory",
      index: "projects/my-repo/memory/MEMORY.md",
      index_path: join(root, "projects/my-repo/memory/MEMORY.md"),
    });
  });

  test("a folder outside any vault project uses personal memory", async () => {
    const root = vault();
    for (const workspace of [scratch("plain"), gitRepo("unrelated")]) {
      const scope = (await json(root, ["memory", "scope", "--workspace", workspace])) as {
        project: string;
      };
      expect(scope.project).toBe("personal");
    }
  });

  test("an unknown or path-like project is refused", async () => {
    const root = vault();
    for (const project of ["nope", "../my-repo", "my-repo/memory"]) {
      const result = await cli(root, ["memory", "scope", "--project", project]);
      expect(result.exitCode).toBe(1);
    }
  });
});

describe("memory save", () => {
  test("writes a Claude-format topic note and its index line", async () => {
    const root = vault();
    const saved = await json(root, [...save("use-uv", "--type", "feedback", "--title", "Use uv")]);
    expect(saved).toEqual({
      path: "projects/my-repo/memory/use-uv.md",
      index: "projects/my-repo/memory/MEMORY.md",
      created: true,
    });
    const note = read(root, "projects/my-repo/memory/use-uv.md");
    expect(note).toMatch(
      /^---\ndescription: When use-uv matters\nmetadata:\n {2}node_type: memory\n {2}type: feedback\n {2}modified: \d{4}-\d\d-\d\dT[\d:.]+Z\nname: use-uv\n---\n\nThe use-uv fact\.\n$/,
    );
    expect(read(root, "projects/my-repo/memory/MEMORY.md")).toBe(
      "# Memory index\n\n- [Use uv](use-uv.md) — When use-uv matters\n",
    );
  });

  test("saving a name again replaces its body and line and keeps other properties", async () => {
    const root = vault({
      "projects/my-repo/memory/MEMORY.md":
        "# Memory index\n\n- [Old](use-uv.md) — old hook\n- [Other](other.md) — other hook\n",
      "projects/my-repo/memory/use-uv.md":
        "---\nname: use-uv\ndescription: old hook\nmetadata:\n  node_type: memory\n  type: feedback\n  originSessionId: abc\n  modified: 2026-01-01T00:00:00.000Z\n---\n\nOld body.\n",
    });
    const saved = (await json(root, save("use-uv", "--type", "feedback"))) as {
      created: boolean;
    };
    expect(saved.created).toBe(false);
    const note = read(root, "projects/my-repo/memory/use-uv.md");
    expect(note).toContain("originSessionId: abc");
    expect(note).toContain("The use-uv fact.");
    expect(note).not.toContain("Old body.");
    expect(note).not.toContain("2026-01-01");
    expect(read(root, "projects/my-repo/memory/MEMORY.md")).toBe(
      "# Memory index\n\n- [Use uv](use-uv.md) — When use-uv matters\n- [Other](other.md) — other hook\n",
    );
  });

  test("a save that would pass 200 index lines fails and writes nothing", async () => {
    const lines = Array.from({ length: 198 }, (_, i) => `- [M${i}](m${i}.md) — hook ${i}`);
    const index = `# Memory index\n\n${lines.join("\n")}\n`;
    const root = vault({ "projects/my-repo/memory/MEMORY.md": index });

    const result = await cli(root, save("one-too-many"));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("201 lines");
    expect(existsSync(join(root, "projects/my-repo/memory/one-too-many.md"))).toBe(false);
    expect(read(root, "projects/my-repo/memory/MEMORY.md")).toBe(index);
    // Replacing a listed memory does not add a line, so it still works.
    await json(root, save("m3"));
  });

  test("a save that would pass the index byte limit fails and writes nothing", async () => {
    // 103 lines, 10 bytes under the limit: the new line passes the bytes, not the lines.
    const lines = Array.from({ length: 100 }, (_, i) => `- [M${i}](m${i}.md) — hook ${i}`);
    let index = `# Memory index\n\n${lines.join("\n")}\n`;
    const pad = "- [Pad](pad.md) — ";
    const room = 24_990 - Buffer.byteLength(index + pad, "utf8") - 1;
    index += `${pad}${"x".repeat(room)}\n`;
    expect(Buffer.byteLength(index, "utf8")).toBe(24_990);
    const root = vault({ "projects/my-repo/memory/MEMORY.md": index });

    const result = await cli(root, save("one-too-big"));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "MEMORY.md would have 25051 bytes, more than the 25000 that agents load; merge or forget memories first\n",
    );
    expect(existsSync(join(root, "projects/my-repo/memory/one-too-big.md"))).toBe(false);
    expect(read(root, "projects/my-repo/memory/MEMORY.md")).toBe(index);
  });

  test("invalid names, types, and descriptions are refused", async () => {
    const root = vault();
    const bad = [
      save("../escape"),
      save("Upper"),
      save("ok", "--type", "secret"),
      ["memory", "save", "ok", "two\nlines", "body", "--project", "my-repo"],
      ["memory", "save", "ok", "hook", "   ", "--project", "my-repo"],
    ];
    for (const argv of bad) {
      expect((await cli(root, argv)).exitCode).not.toBe(0);
    }
    expect(existsSync(join(root, "projects/my-repo/memory"))).toBe(false);
  });

  test("a memory folder linked outside the vault is refused", async () => {
    const root = vault();
    const outside = scratch("outside");
    symlinkSync(outside, join(root, "projects/my-repo/memory"));
    const result = await cli(root, save("leak"));
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "leak.md"))).toBe(false);
  });
});

describe("memory forget", () => {
  test("removes the note and its index line, and fails for an unknown name", async () => {
    const root = vault();
    await json(root, save("keep"));
    await json(root, save("drop"));

    await json(root, ["memory", "forget", "drop", "--project", "my-repo"]);

    expect(existsSync(join(root, "projects/my-repo/memory/drop.md"))).toBe(false);
    expect(read(root, "projects/my-repo/memory/MEMORY.md")).toBe(
      "# Memory index\n\n- [Keep](keep.md) — When keep matters\n",
    );
    const again = await cli(root, ["memory", "forget", "drop", "--project", "my-repo"]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("no memory named 'drop'");
  });
});

describe("memory search", () => {
  test("keeps only the scope's own topic notes", async () => {
    const note = (text: string) =>
      `---\nname: x\ndescription: x\nmetadata:\n  node_type: memory\n  type: project\n---\n\n${text}\n`;
    const root = vault({
      "projects/my-repo/memory/MEMORY.md": "# Memory index\n\n- zebrafish heater index line\n",
      "projects/my-repo/memory/tank.md": note("The zebrafish tank needs a heater."),
      "projects/my-repo/memory/hermes/MEMORY.md": "zebrafish heater, Hermes only\n",
      "projects/my-repo/notes.md": "# Notes\n\nzebrafish heater outside memory\n",
      "projects/personal/memory/tank.md": note("Another zebrafish heater."),
    });
    const env = isolatedEnv();
    const config = join(env.QMD_CONFIG_DIR as string, "index.yml");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, `collections:\n  llmos:\n    path: ${root}\n    pattern: "**/*.md"\n`);
    mkdirSync(dirname(env.INDEX_PATH as string), { recursive: true });
    const store = await openQmd(qmdLocation(env), true);
    try {
      await store.update({ collections: ["llmos"] });
    } finally {
      await store.close();
    }

    const hits = (await json(
      root,
      ["memory", "search", "zebrafish heater", "--keyword", "--project", "my-repo"],
      env,
    )) as { path: string }[];

    expect(hits.map((hit) => hit.path)).toEqual(["projects/my-repo/memory/tank.md"]);
  });
});

test("the session-start index reader still bounds what it reads", async () => {
  const { readMemoryIndex } = await import("../src/memory.ts");
  const root = scratch("index");
  writeFiles(root, {
    "short.md": "# Memory index\n\n- [A](a.md) — a\n\n",
    "long.md": Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n"),
  });
  expect(readMemoryIndex(join(root, "short.md"))).toBe("# Memory index\n\n- [A](a.md) — a");
  const long = readMemoryIndex(join(root, "long.md")) ?? "";
  expect(long.split("\n")).toHaveLength(201);
  expect(long.endsWith("line 199\n[MEMORY.md truncated]")).toBe(true);
  expect(readMemoryIndex(join(root, "missing.md"))).toBeNull();
});

test("a full index with its final newline is read whole, without a truncation mark", async () => {
  const { readMemoryIndex } = await import("../src/memory.ts");
  const root = scratch("index");
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  writeFiles(root, { "full.md": `${lines.join("\n")}\n` });
  expect(readMemoryIndex(join(root, "full.md"))).toBe(lines.join("\n"));
});
