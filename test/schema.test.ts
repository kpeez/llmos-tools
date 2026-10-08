import { expect, test } from "bun:test";
import { collectErrors } from "../src/schema.ts";
import { VaultModel } from "../src/vault.ts";
import { makeVault } from "./helpers.ts";

test("a new note with a non-ASCII name gets the new-note created check", () => {
  const root = makeVault({ "notes/caf\u00e9.md": "---\nstatus: draft\n---\n\n# Caf\u00e9\n" });
  const git = (...args: string[]) =>
    expect(Bun.spawnSync(["git", "-C", root, ...args]).exitCode).toBe(0);
  git("init", "--quiet");
  git("config", "core.quotePath", "true"); // git's default; it quotes this name
  const { errors } = collectErrors(VaultModel.load(root));
  expect(errors).toContain("notes/caf\u00e9.md: created must be an ISO date");
});
