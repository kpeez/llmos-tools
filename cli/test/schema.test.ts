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

test("a category must name a hub in categories/ by its plain name", () => {
  const hub = "---\ntags:\n  - categories\n---\n\n# Papers\n";
  const withCategories = (...values: string[]) =>
    `---\ncategories:\n${values.map((value) => `  - "${value}"\n`).join("")}---\n\n# Note\n`;
  const root = makeVault({
    "categories/Papers.md": hub,
    "knowledge/paper.md": withCategories("[[Papers]]"),
    "knowledge/typo.md": withCategories("[[Paper]]", "[[papers]]"),
    "knowledge/qualified.md": withCategories(
      "[[categories/Papers|Papers]]",
      "[[Papers|Alias]]",
      "[[Papers#Heading]]",
    ),
  });
  const { errors } = collectErrors(VaultModel.load(root));
  expect(errors.filter((error) => error.includes("category"))).toEqual([
    'knowledge/qualified.md: category "[[categories/Papers|Papers]]" names no hub in categories/',
    'knowledge/qualified.md: category "[[Papers|Alias]]" names no hub in categories/',
    'knowledge/qualified.md: category "[[Papers#Heading]]" names no hub in categories/',
    'knowledge/typo.md: category "[[Paper]]" names no hub in categories/',
    'knowledge/typo.md: category "[[papers]]" names no hub in categories/',
  ]);
});

test("project memory notes under projects/<project>/memory/ are skipped", () => {
  const root = makeVault({
    "projects/demo/memory/MEMORY.md": "# Memory Index\n\n- [Topic](topic.md) — summary\n",
    "projects/demo/memory/topic.md":
      "---\nname: Topic note\ndescription: Working memory\nmetadata:\n  node_type: memory\n  type: project\n---\n\nDetails.\n",
    "projects/demo/memory/nested/sub.md": "# Sub\n",
    "projects/demo/notes/durable.md": "---\nstatus: draft\n---\n\n# Durable\n",
  });
  const { errors, checked } = collectErrors(VaultModel.load(root));
  // AGENTS.md (from makeVault) + projects/demo/notes/durable.md; the 3 memory notes are skipped.
  expect(checked).toBe(2);
  expect(errors).toEqual([
    "AGENTS.md: missing frontmatter",
    "projects/demo/notes/durable.md: project-owned note lacks project link",
  ]);
});
