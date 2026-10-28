import { describe, expect, test } from "bun:test";
import {
  Frontmatter,
  ImmutableProperty,
  MissingFrontmatter,
  normalize,
  parse,
  serialize,
  UnsupportedFrontmatter,
} from "../src/frontmatter.ts";

const note = (block: string, body = "# Body\n"): string => `---\n${block}---\n${body}`;

describe("normalize writes the canonical form", () => {
  // Inputs the retired Python serializer also accepted; the expected text was its output.
  const cases: [string, string, string][] = [
    [
      "sorted keys, flow list to block, quoted wikilink, body whitespace",
      note("updated: 2026-07-17\ntopics: [b, '[[A]]']\ncreated: '2026-07-16'\n", "# T \t\n\n\n"),
      '---\ncreated: 2026-07-16\ntopics:\n  - b\n  - "[[A]]"\nupdated: 2026-07-17\n---\n\n# T\n',
    ],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(normalize(input)).toBe(expected);
      expect(normalize(expected)).toBe(expected);
    });
  }
});

describe("normalize keeps YAML the Python parser refused", () => {
  test("a literal block scalar survives byte for byte, including trailing spaces", () => {
    const input = note("updated: 2026-10-01\nmethod: |\n  first line  \n\n  third [[x]]\nb: y\n");
    const output = normalize(input);
    expect(output).toBe(
      "---\nb: y\nmethod: |\n  first line  \n\n  third [[x]]\nupdated: 2026-10-01\n---\n\n# Body\n",
    );
    expect(parse(output).properties.method).toBe("first line  \n\nthird [[x]]\n");
  });

  test("comments stay with their property when keys are sorted", () => {
    const input = note(
      "# about b\nb: x # inline\n# about a\na:\n  - one # first\n  - two\n# end\n",
    );
    expect(normalize(input)).toBe(
      "---\n# about a\na:\n  - one # first\n  - two\n# about b\nb: x # inline\n# end\n---\n\n# Body\n",
    );
  });

  test("nested maps keep their values and their source layout", () => {
    const input = note(
      'source:\n  url: https://example.org\n  links: ["[[A]]", b]\nauthors: [claude]\n',
    );
    const output = normalize(input);
    expect(output).toBe(
      '---\nauthors:\n  - claude\nsource:\n  url: https://example.org\n  links: ["[[A]]", b]\n---\n\n# Body\n',
    );
    expect(parse(output).properties.source).toEqual({
      url: "https://example.org",
      links: ["[[A]]", "b"],
    });
  });

  test("copied properties lose trailing spaces outside block scalars", () => {
    expect(normalize(note("n:   \n  k: v   \n"))).toBe("---\nn:\n  k: v\n---\n\n# Body\n");
  });

  test("body lines keep a hard line break of two or more spaces and lose other trailing whitespace", () => {
    // CommonMark reads two or more spaces before a line ending as a hard
    // line break; a single space, tabs, and other whitespace are not one.
    const input = note(
      "a: x\n",
      "two  \nthree   \none \ntab\t\ntab then two\t  \ntwo then tab  \t\nnbsp\u00a0\n   \nback\\\ncrlf  \r\nend  \n",
    );
    const once = normalize(input);
    expect(once).toBe(
      "---\na: x\n---\n\ntwo  \nthree   \none\ntab\ntab then two  \ntwo then tab\nnbsp\n\nback\\\ncrlf  \nend  \n",
    );
    expect(normalize(once)).toBe(once);
  });
});

describe("a block that is not valid YAML properties is never rewritten", () => {
  const cases: [string, string][] = [
    ["duplicate key", note("a: x\na: y\n")],
    ["not a map", note("- a\n- b\n")],
    ["empty list item", note("a:\n  -\n  - x\n")],
  ];
  for (const [name, input] of cases) {
    test(name, () => {
      expect(() => normalize(input)).toThrow(UnsupportedFrontmatter);
      expect(() => Frontmatter.parse(input).setScalar("updated", "2026-10-07")).toThrow(
        UnsupportedFrontmatter,
      );
    });
  }

  test("a note without a closed block has no frontmatter", () => {
    expect(() => normalize("# Title\n")).toThrow(MissingFrontmatter);
    expect(() => normalize("---\na: b\n")).toThrow(MissingFrontmatter);
  });

  test("a rewrite that would reorder an alias before its anchor is refused", () => {
    expect(() => normalize(note("z: &x one\na: *x\n"))).toThrow(UnsupportedFrontmatter);
  });
});

describe("property changes", () => {
  test("stamping keeps comments and block scalars elsewhere in the block", () => {
    const fm = Frontmatter.parse(
      note(
        "created: 2026-01-01\nmethod: |\n  kept\n# who\nauthors: [claude]\nupdated: 2026-01-02\n",
      ),
    );
    fm.setScalar("updated", "2026-10-07").appendUnique("authors", "codex");
    expect(fm.toString()).toBe(
      "---\n# who\nauthors:\n  - claude\n  - codex\ncreated: 2026-01-01\nmethod: |\n  kept\nupdated: 2026-10-07\n---\n\n# Body\n",
    );
  });

  test("authors is append-only and created is immutable", () => {
    const fm = Frontmatter.parse(note("authors: claude\ncreated: 2026-01-01\n"));
    fm.appendUnique("authors", "claude").appendUnique("authors", "codex");
    expect(fm.properties.authors).toEqual(["claude", "codex"]);
    expect(() => fm.setScalar("created", "2026-10-07")).toThrow(ImmutableProperty);
    expect(() => fm.delete("created")).toThrow(ImmutableProperty);
    expect(fm.properties.created).toBe("2026-01-01");
  });

  test("setting a property never changes another one through an alias", () => {
    const fm = Frontmatter.parse(note("a: &d 2026-01-01\ncreated: *d\n"));
    expect(() => fm.setScalar("a", "x").toString()).toThrow(UnsupportedFrontmatter);
  });

  test("comments on a removed or replaced value move above a property", () => {
    const removed = Frontmatter.parse(note("# header\na: x # why\nb: y\n"));
    removed.delete("a");
    expect(removed.toString()).toBe("---\n# header\n# why\nb: y\n---\n\n# Body\n");
    const replaced = Frontmatter.parse(note("authors: claude # first\n"));
    replaced.appendUnique("authors", "codex");
    expect(replaced.toString()).toBe(
      "---\n# first\nauthors:\n  - claude\n  - codex\n---\n\n# Body\n",
    );
  });

  test("an empty list item is never written", () => {
    expect(() => serialize({ a: ["x", ""] }, "")).toThrow(UnsupportedFrontmatter);
  });

  test("serialize writes plain properties in canonical form", () => {
    expect(serialize({ topics: ["[[A]]"], status: "active", none: [] }, "# T\n")).toBe(
      '---\nnone: []\nstatus: active\ntopics:\n  - "[[A]]"\n---\n\n# T\n',
    );
  });
});
