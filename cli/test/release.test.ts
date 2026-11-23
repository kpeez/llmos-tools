import { expect, test } from "bun:test";
import {
  bumpVersion,
  failures,
  hasHeading,
  moveUnreleased,
  VERSION_FILES,
} from "../scripts/release.ts";

const fields = (version: string, odd?: string) =>
  Object.fromEntries(VERSION_FILES.map((f, i) => [f, i === 3 && odd ? odd : version]));
const changelog = "## Unreleased\n\n- note\n\n## 1.0.0 — 2026-01-01\n\n- old\n";

test("a release level bumps the version and resets the lower parts", () => {
  expect(bumpVersion("2.13.1", "major")).toBe("3.0.0");
  expect(bumpVersion("2.13.1", "minor")).toBe("2.14.0");
  expect(bumpVersion("2.13.1", "patch")).toBe("2.13.2");
});

test("the Unreleased notes move under a dated heading; an empty body is refused", () => {
  const moved = moveUnreleased(changelog, "1.0.1", "2026-02-02");
  expect(moved).toBe(
    "## Unreleased\n\n## 1.0.1 — 2026-02-02\n\n- note\n\n## 1.0.0 — 2026-01-01\n\n- old\n",
  );
  expect(hasHeading(moved, "1.0.1")).toBe(true);
  expect(() =>
    moveUnreleased("## Unreleased\n\n## 1.0.0 — 2026-01-01\n", "1.0.1", "2026-02-02"),
  ).toThrow();
});

test("the check fails on differing fields, a version with no heading, and a wrong PR title", () => {
  const ok = { fields: fields("1.0.0"), baseVersion: "1.0.0", changelog, prTitle: null };
  expect(failures(ok)).toEqual([]);
  expect(failures({ ...ok, fields: fields("1.0.0", "1.0.1") })).toHaveLength(1);
  expect(failures({ ...ok, fields: fields("1.0.1") })).toHaveLength(1);
  const released = {
    ...ok,
    fields: fields("1.0.1"),
    changelog: moveUnreleased(changelog, "1.0.1", "2026-02-02"),
  };
  expect(failures(released)).toEqual([]);
  expect(failures({ ...released, prTitle: "fix: x" })).toHaveLength(1);
  expect(failures({ ...released, prTitle: "chore(release): 1.0.1" })).toEqual([]);
});
