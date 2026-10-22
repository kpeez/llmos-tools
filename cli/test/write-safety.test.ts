/**
 * Writes stay inside the vault: no absolute or `..` targets, and no write
 * through a symbolic link (to a note or a folder) whose real path is outside
 * the real vault root. Arguments are checked by the handlers themselves, so a
 * caller that skips the command line (the MCP server) gets the same checks.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { UsageError, type Values } from "../src/cli.ts";
import { COMMANDS } from "../src/commands.ts";
import { appendContent, createNote, setProperty, WriteRefused } from "../src/write.ts";
import { cli, makeVault, read, recordedObsidian, scratch } from "./helpers.ts";

const NOTE = "---\nstatus: draft\n---\n\n# Note\n";

function outside(): string {
  const folder = scratch("outside");
  writeFileSync(join(folder, "secret.md"), NOTE);
  return folder;
}

describe("write targets", () => {
  test("absolute and climbing paths are refused before anything is written", async () => {
    const root = makeVault({ "inbox/capture.md": NOTE, "notes/alpha.md": NOTE });
    const away = outside();
    const obsidian = recordedObsidian(root);
    for (const argv of [
      ["create", "../escape"],
      ["create", "notes/../../escape"],
      ["create", join(away, "new")],
      ["move", "alpha", "../escape.md"],
      ["move", "alpha", join(away, "moved.md")],
      ["file-inbox", "capture", "knowledge/../../escape"],
    ]) {
      const result = await cli(root, argv, { obsidian: obsidian.runner });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not a path inside the vault");
    }
    expect(obsidian.calls).toEqual([]);
    expect(existsSync(join(root, "..", "escape.md"))).toBe(false);
    expect(existsSync(join(away, "new.md"))).toBe(false);
  });

  test("a symlinked note that points outside the vault is never written", async () => {
    const away = outside();
    const root = makeVault();
    symlinkSync(join(away, "secret.md"), join(root, "link.md"));
    for (const argv of [
      ["set-property", "link", "status", "active"],
      ["remove-property", "link", "status"],
      ["append", "link", "text"],
    ]) {
      const result = await cli(root, argv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("outside the vault");
    }
    expect(readFileSync(join(away, "secret.md"), "utf8")).toBe(NOTE);
  });

  test("a symlinked folder that points outside the vault is never written into", () => {
    const away = outside();
    const root = makeVault();
    symlinkSync(away, join(root, "linked"));
    expect(() => createNote(root, "linked/new.md", "x\n")).toThrow(WriteRefused);
    expect(() => createNote(root, "linked/deeper/new.md", "x\n")).toThrow(WriteRefused);
    expect(() => setProperty(root, "linked/secret.md", "status", "x")).toThrow(WriteRefused);
    expect(() => appendContent(root, "linked/secret.md", "x")).toThrow(WriteRefused);
    expect(existsSync(join(away, "new.md"))).toBe(false);
    expect(existsSync(join(away, "deeper"))).toBe(false);
    expect(readFileSync(join(away, "secret.md"), "utf8")).toBe(NOTE);
  });

  test("a symlinked folder inside the vault is written through", () => {
    const root = makeVault({ "real/note.md": NOTE });
    symlinkSync(join(root, "real"), join(root, "alias"));
    setProperty(root, "alias/note.md", "status", "done");
    createNote(root, "alias/new.md", "# New\n");
    expect(read(root, "real/note.md")).toContain("status: done");
    expect(read(root, "real/new.md")).toBe("# New\n");
  });

  test("a vault reached through a symlinked root still accepts its own notes", async () => {
    const root = makeVault({ "notes/alpha.md": NOTE });
    const alias = join(scratch("alias"), "vault");
    symlinkSync(root, alias);
    mkdirSync(join(root, "notes", "sub"));
    const result = await cli(alias, ["set-property", "alpha", "status", "active"]);
    expect(result.exitCode).toBe(0);
    expect(read(root, "notes/alpha.md")).toContain("status: active");
  });
});

describe("argument checks", () => {
  test("bad property names, values, templates, and counts exit 2", async () => {
    const root = makeVault({ "notes/alpha.md": NOTE });
    for (const argv of [
      ["set-property", "alpha", "", "x"],
      ["set-property", "alpha", " status", "x"],
      ["set-property", "alpha", "sta\ntus", "x"],
      ["set-property", "alpha", "status", "two\nlines"],
      ["remove-property", "alpha", "bad\u0000key"],
      ["create", "notes/t", "--template", "../escape"],
      ["create", "notes/t", "--template", "/abs"],
      ["daily", "recent", "--n", "-1"],
      ["subgraph", "alpha", "--depth", "-2"],
      ["search", "x", "--limit", "0"],
    ]) {
      const result = await cli(root, argv);
      expect(result.exitCode).toBe(2);
    }
    expect(read(root, "notes/alpha.md")).toBe(NOTE);
  });

  test("handlers check their values when called without the command line", () => {
    const read = COMMANDS.find((command) => command.name === "read");
    const values: Values = { note: "alpha", vault: "../elsewhere" };
    expect(() => read?.run(values, {} as never)).toThrow(UsageError);
  });
});

describe("every path-taking command refuses to escape the vault", () => {
  // `{away}` is a folder outside the vault holding secret.md. In the vault,
  // link.md links to that file and linkdir/ links to the folder.
  const ESCAPES = ["../escape.md", "{away}/secret.md", "link.md", "linkdir/new.md"];
  const NOTE_ESCAPES = ["../escape.md", "{away}/secret.md"];
  const cases: [string, string[]][] = [];
  for (const path of ESCAPES) {
    cases.push(
      [`create ${path}`, ["create", path, "--content", "x"]],
      [`create --template ${path}`, ["create", path, "--template", "project"]],
      [`move to ${path}`, ["move", "alpha", path]],
      [`file-inbox to ${path}`, ["file-inbox", "capture", path]],
    );
  }
  // `docs` paths are relative to the working folder and must stay in tools/.
  for (const path of ["../../escape.md", "../../../escape.md", "{away}/secret.md"]) {
    cases.push(
      [`docs --reference ${path}`, ["docs", "--reference", path]],
      [`docs --skill ${path}`, ["docs", "--skill", path]],
    );
  }
  for (const path of ["knowledge/../../escape.md", "knowledge/../linkdir/new.md"]) {
    cases.push([`file-inbox to ${path}`, ["file-inbox", "capture", path]]);
  }
  for (const note of [...NOTE_ESCAPES, "link.md"]) {
    cases.push(
      [`append ${note}`, ["append", note, "x"]],
      [`set-property ${note}`, ["set-property", note, "status", "x"]],
      [`remove-property ${note}`, ["remove-property", note, "status"]],
      [`check ${note}`, ["check", note]],
      [`file-inbox from ${note}`, ["file-inbox", note, "knowledge/filed.md"]],
    );
  }
  for (const note of NOTE_ESCAPES) {
    cases.push(
      [`move from ${note}`, ["move", note, "notes/moved.md"]],
      [`read ${note}`, ["read", note]],
      [`neighbors ${note}`, ["neighbors", note]],
      [`subgraph ${note}`, ["subgraph", note]],
    );
  }

  for (const [label, argv] of cases) {
    test(label, async () => {
      const away = outside();
      const root = makeVault({ "notes/alpha.md": NOTE, "inbox/capture.md": NOTE });
      symlinkSync(join(away, "secret.md"), join(root, "link.md"));
      symlinkSync(away, join(root, "linkdir"));
      const obsidian = recordedObsidian(root);
      const args = argv.map((arg) => arg.replace("{away}", away));
      const result = await cli(root, args, { obsidian: obsidian.runner });
      expect(result.exitCode).not.toBe(0);
      expect(obsidian.calls).toEqual([]);
      expect(readdirSync(away)).toEqual(["secret.md"]);
      expect(readFileSync(join(away, "secret.md"), "utf8")).toBe(NOTE);
      expect(existsSync(join(root, "..", "escape.md"))).toBe(false);
    });
  }

  test("reads follow a symlinked note, as Obsidian shows it; nothing is written", async () => {
    const away = outside();
    const root = makeVault();
    symlinkSync(join(away, "secret.md"), join(root, "link.md"));
    const result = await cli(root, ["read", "link"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).properties).toEqual({ status: "draft" });
  });
});
