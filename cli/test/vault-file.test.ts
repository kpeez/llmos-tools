/** `resolveInVault` is the one door to a vault file: every escape is refused. */

import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { readText, readWalkedNote, resolveInVault, WriteRefused } from "../src/vault-file.ts";
import { makeVault, scratch, writeFiles } from "./helpers.ts";

function vaultWithHostileEntries(): string {
  const root = makeVault({
    "notes/ok.md": "# ok\n",
    ".trash/gone.md": "# gone\n",
    "notes/.hidden/h.md": "# h\n",
    "notes/folder/inner.md": "# inner\n",
  });
  const outside = scratch("outside");
  writeFiles(outside, { "secret.md": "secret\n", "dir/leak.md": "leak\n" });
  symlinkSync(join(outside, "secret.md"), join(root, "notes/out.md"));
  symlinkSync(join(outside, "dir"), join(root, "notes/outdir"));
  symlinkSync(join(root, "notes/ok.md"), join(root, "notes/in.md"));
  symlinkSync(join(root, ".trash"), join(root, "notes/to-trash"));
  symlinkSync(join(outside, "missing.md"), join(root, "notes/dangling.md"));
  mkdirSync(join(root, "notes/adir"));
  return root;
}

test("a note inside the vault, or a link to one, gives a readable VaultFile", () => {
  const root = vaultWithHostileEntries();
  expect(readText(resolveInVault(root, "notes/ok.md"))).toBe("# ok\n");
  expect(readText(resolveInVault(root, "notes/in.md"))).toBe("# ok\n");
});

test.each([
  ["a path with '..' out of the vault", "../outside.md"],
  ["an absolute path", "/etc/hosts"],
  ["the empty path", ""],
  ["a link to a file outside the vault", "notes/out.md"],
  ["a file in a link to a folder outside the vault", "notes/outdir/leak.md"],
  ["a link to a missing file", "notes/dangling.md"],
  ["a file in a dot folder", ".trash/gone.md"],
  ["a file in a nested dot folder", "notes/.hidden/h.md"],
  ["a file reached through a link into a dot folder", "notes/to-trash/gone.md"],
  ["a folder", "notes/adir"],
])("%s is refused", (_name, path) => {
  const root = vaultWithHostileEntries();
  expect(() => resolveInVault(root, path)).toThrow(WriteRefused);
});

test("a missing file is the OS error, not a refusal", () => {
  const root = vaultWithHostileEntries();
  expect(() => resolveInVault(root, "notes/none.md")).toThrow(/ENOENT/);
});

test("a walked note follows a link but never a '..' or an absolute path", () => {
  const root = vaultWithHostileEntries();
  expect(readWalkedNote(root, "notes/out.md")).toBe("secret\n");
  expect(() => readWalkedNote(root, "../outside.md")).toThrow(WriteRefused);
  expect(() => readWalkedNote(root, "/etc/hosts")).toThrow(WriteRefused);
});
