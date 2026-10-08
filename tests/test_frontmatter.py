"""Prove `llmos_vault.frontmatter`: the one canonical YAML-frontmatter
reader/writer (ADR-0004 -- "one frontmatter owner"). Normalization fixes key
order, the blank line after YAML, trailing whitespace, and the trailing
newline, without touching body content or wikilink quoting in YAML values.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from llmos_vault.frontmatter import (
    MissingFrontmatter,
    Property,
    UnsupportedFrontmatter,
    append_unique,
    normalize,
    parse,
    serialize,
    set_scalar,
)

FIXTURES = Path(__file__).parent / "fixtures" / "vault" / "notes"


def test_parse_splits_properties_and_body():
    properties, body = parse((FIXTURES / "normalized.md").read_text())

    assert properties["created"] == "2026-07-01"
    assert properties["authors"] == ["claude"]
    assert body.startswith("# Normalized fixture note")


def test_wikilink_quoting_preserved_in_parsed_value():
    properties, _ = parse((FIXTURES / "normalized.md").read_text())

    assert properties["categories"] == ["[[Knowledge]]"]


def test_round_trip_of_already_normalized_note_is_byte_identical():
    text = (FIXTURES / "normalized.md").read_text()

    assert normalize(text) == text


def test_normalize_twice_equals_normalize_once():
    text = (FIXTURES / "messy.md").read_text()

    once = normalize(text)
    twice = normalize(once)

    assert twice == once


def test_normalize_fixes_key_order():
    text = (FIXTURES / "messy.md").read_text()

    normalized = normalize(text)
    properties, _ = parse(normalized)

    assert list(properties.keys()) == sorted(properties.keys())


def test_normalize_adds_blank_line_after_yaml():
    text = (FIXTURES / "messy.md").read_text()

    normalized = normalize(text)

    assert "\n---\n\n#" in normalized


def test_normalize_strips_trailing_whitespace():
    text = (FIXTURES / "messy.md").read_text()

    normalized = normalize(text)

    for line in normalized.splitlines():
        assert line == line.rstrip()


def test_normalize_ends_with_single_trailing_newline():
    text = (FIXTURES / "messy.md").read_text()

    normalized = normalize(text)

    assert normalized.endswith("\n")
    assert not normalized.endswith("\n\n")


def test_normalize_preserves_body_content():
    text = (FIXTURES / "messy.md").read_text()

    normalized = normalize(text)

    assert "[[Some Other Note]]" in normalized
    assert "Body content, including a wikilink" in normalized


def test_serialize_quotes_wikilink_values():
    properties: dict[str, Property] = {"categories": ["[[Knowledge]]"]}

    rendered = serialize(properties, "# body\n")

    assert '  - "[[Knowledge]]"' in rendered


def test_set_scalar_refuses_to_rewrite_created():
    properties: dict[str, Property] = {"created": "2026-07-01"}

    try:
        set_scalar(properties, "created", "2026-07-17")
        raised = False
    except ValueError:
        raised = True

    assert raised
    assert properties["created"] == "2026-07-01"


def test_append_unique_appends_when_absent():
    properties: dict[str, Property] = {"authors": ["claude"]}

    append_unique(properties, "authors", "codex")

    assert properties["authors"] == ["claude", "codex"]


def test_append_unique_is_a_no_op_when_already_present():
    properties: dict[str, Property] = {"authors": ["claude", "codex"]}

    append_unique(properties, "authors", "codex")

    assert properties["authors"] == ["claude", "codex"]


def test_empty_scalar_parses_as_empty_string_not_list():
    text = "---\ncreated: 2026-07-01\nnote:\n---\n\n# body\n"

    properties, _ = parse(text)

    assert properties["note"] == ""


def test_explicit_empty_list_still_parses_as_list():
    text = "---\ncreated: 2026-07-01\ntags: []\n---\n\n# body\n"

    properties, _ = parse(text)

    assert properties["tags"] == []


def test_empty_scalar_round_trips_byte_identically():
    text = "---\ncreated: 2026-07-01\nnote:\n---\n\n# body\n"

    assert normalize(text) == text


def test_parse_inline_flow_list():
    text = "---\ntags: [alpha, beta]\n---\n\n# body\n"

    properties, _ = parse(text)

    assert properties["tags"] == ["alpha", "beta"]


def test_normalize_converts_inline_list_to_canonical_block_style():
    text = "---\ntags: [alpha, beta]\n---\n\n# body\n"

    normalized = normalize(text)

    assert "tags:\n  - alpha\n  - beta\n" in normalized


def test_normalize_inline_list_is_idempotent():
    text = "---\ntags: [alpha, beta]\n---\n\n# body\n"

    once = normalize(text)
    twice = normalize(once)

    assert twice == once


@pytest.mark.parametrize(
    "frontmatter",
    [
        "method: |\n  first line\n  second: line\n",
        "method: >-\n  folded\n",
        "nested:\n  key: value\n",
        "# a comment\ntitle: kept\n",
        "base: &anchor value\n",
        "tags:\n- top-level item\n",
        "title: one\ntitle: two\n",
        "status: active\n  - stray item\n",
        # Inline comments: quoting them would fold the comment into the value.
        "status: active # revisit\n",
        "summary: # TODO\n",
        "tags:\n  - alpha # old\n",
        'title: "x" # note\n',
        # List items and flow elements get the same checks as scalars.
        "a:\n  - &x one\nb:\n  - *x\n",
        "tags:\n  - !!str x\n",
        "tags:\n  - k: v\n",
        "tags:\n  - [x, y]\n",
        "tags:\n  - - x\n",
        'tags:\n  - "x\n',
        "a: [x, [y]]\n",
        "a: [k: v]\n",
        "a: [why?]\n",
        # Escapes other than \\ and \" would be kept as literal text.
        'summary: "line one\\nline two"\n',
        'tags: ["caf\\u00e9"]\n',
        # Malformed lists and quotes are refused, not repaired.
        "a: [x, , y]\n",
        "related: [[A]], [[B]]\n",
        "project: [[X]]\n",
        'a: "x"y"\n',
        "a: 'it's'\n",
        "url:http://example.org\n",
        "a:\tb\n",
        # Quoted text that bare YAML reads as null, a bool, or a number would
        # change type when written back unquoted.
        'version: "1.10"\n',
        'flag: "true"\n',
        "zip: '01234'\n",
        'a: "null"\n',
        'a: ""\n',
        'tags:\n  - "yes"\n',
        'time: "12:30"\n',
        'mask: "0b101"\n',
        # Items belong only under a bare `key:` line.
        "a: [x]\n  - y\n",
        "a: []\n  - y\n",
        # Characters YAML rejects must not split one line into two.
        "a: x\x0bb: y\n",
        "a: x\x0cb: y\n",
        "a: x\r\n",
    ],
)
def test_parse_refuses_yaml_it_cannot_represent(frontmatter):
    # Each shape used to parse into something else, and `normalize` then wrote
    # that over the note -- a block scalar became a property named after its
    # own text (the rfdetr segmentation review in the real vault).
    with pytest.raises(ValueError):
        parse(f"---\n{frontmatter}---\n\n# body\n")


def test_flow_list_keeps_commas_inside_quotes():
    properties, _ = parse('---\ntags: [a, "b, c"]\n---\n\n# body\n')

    assert properties["tags"] == ["a", "b, c"]


@pytest.mark.parametrize(
    "value",
    [
        "[SUPERSEDED by repo-reorg] Unify paths",
        "`uv run pytest` fails",
        "Audit the suites (PR #62), then trim",
        "ratio: 3 to 1",
        "{{date:YYYY-MM-DD}}",
        '"hi," she said',
    ],
)
def test_values_that_need_quotes_survive_normalize(value):
    # Writing these bare changes their YAML meaning: a list, a comment, a map.
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    text = f'---\ndesc: "{escaped}"\nitems:\n  - "{escaped}"\n---\n\n# body\n'

    normalized = normalize(text)
    properties, _ = parse(normalized)

    assert properties == {"desc": value, "items": [value]}
    assert normalized == text


def test_flow_list_drops_one_trailing_comma():
    properties, _ = parse("---\ntags: [alpha, beta, ]\n---\n\n# body\n")

    assert properties["tags"] == ["alpha", "beta"]


def test_flow_list_honors_escaped_quotes():
    properties, _ = parse('---\ntags: ["x\\", y\\"", z]\n---\n\n# body\n')

    assert properties["tags"] == ['x", y"', "z"]


def test_serialize_refuses_an_empty_list_item_it_could_not_reparse():
    with pytest.raises(ValueError):
        serialize({"tags": ["a", ""]}, "# body\n")


def test_serialize_refuses_line_breaks_it_cannot_write():
    with pytest.raises(ValueError):
        serialize({"summary": "line one\nline two"}, "# body\n")


def test_missing_and_unsupported_blocks_raise_distinct_errors():
    with pytest.raises(MissingFrontmatter):
        parse("# no block\n")
    with pytest.raises(UnsupportedFrontmatter):
        parse("---\nmethod: |\n  text\n---\n\n# body\n")


def test_quoted_dates_are_accepted_and_written_bare():
    # YAML 1.2 reads a bare date as a string too; the daily template quotes it.
    text = '---\ncreated: "2026-07-16"\n---\n\n# body\n'

    assert normalize(text) == "---\ncreated: 2026-07-16\n---\n\n# body\n"
