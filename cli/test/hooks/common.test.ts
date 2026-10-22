import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { realpath } from "../../src/hooks/common.ts";
import { removeTemporaryFolders, temporaryFolder } from "./helpers.ts";

afterEach(removeTemporaryFolders);

test("realpath follows links before `..` and keeps parts that do not exist yet", () => {
  const tmp = temporaryFolder();
  mkdirSync(join(tmp, "vault", "projects", "p"), { recursive: true });
  mkdirSync(join(tmp, "repo"));
  symlinkSync(join(tmp, "vault", "projects", "p"), join(tmp, "repo", "docs"));
  symlinkSync("../vault", join(tmp, "repo", "relative"));
  symlinkSync("loop", join(tmp, "loop"));

  // A string, because `join` would fold the `..` before the link resolves.
  expect(realpath(`${tmp}/repo/docs/../q.md`)).toBe(join(tmp, "vault", "projects", "q.md"));
  expect(realpath(join(tmp, "repo", "relative", "new", "note.md"))).toBe(
    join(tmp, "vault", "new", "note.md"),
  );
  expect(realpath(`${tmp}//repo/./docs/`)).toBe(join(tmp, "vault", "projects", "p"));
  expect(realpath(join(tmp, "loop", "x"))).toBe(join(tmp, "loop", "x"));
  expect(realpath("/")).toBe("/");
});
