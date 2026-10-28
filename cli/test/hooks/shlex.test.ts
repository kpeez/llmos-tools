/**
 * The guard and the shell-read gate split commands as Python's `shlex` did,
 * because the guard rules were defined on those tokens. Expected values come
 * from CPython 3.9 and 3.14 (the same for both).
 */

import { expect, test } from "bun:test";
import { ShlexError, split, splitWithOperators } from "../../src/hooks/shlex.ts";

test.each([
  ["cat 'a b.md' c", ["cat", "a b.md", "c"]],
  ["a''", ["a"]],
  ['"a\\"b"', ['a"b']],
  ['"a\\$b"', ["a\\$b"]],
  ["a#b c", ["a#b", "c"]],
])("split(%j)", (command, expected) => {
  expect(split(command)).toEqual(expected);
});

test.each([
  ["echo hi&&rm x.md", ["echo", "hi", "&&", "rm", "x.md"]],
  ["mv a 2>&1 b", ["mv", "a", "2", ">&", "1", "b"]],
  ["rm 'x y.md' # c", ["rm", "x y.md"]],
  ["a#b", ["a"]],
])("splitWithOperators(%j)", (command, expected) => {
  expect(splitWithOperators(command)).toEqual(expected);
});

test("an unterminated quote or a trailing escape throws ShlexError", () => {
  expect(() => split("'a")).toThrow(ShlexError);
  expect(() => splitWithOperators('rm "a')).toThrow(ShlexError);
  expect(() => split("a\\")).toThrow(ShlexError);
});
