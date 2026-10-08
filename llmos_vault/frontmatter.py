"""The one canonical YAML-frontmatter reader/writer for the vault.

Hooks and every later verb import this module in-process (ADR-0004) -- no
second serializer may exist. Values are stored unquoted; quoting is decided
on output from content alone (a wikilink like `[[Knowledge]]`, or any value
that bare YAML would read differently, such as one starting with `[` or
containing ` #`, is written double-quoted), which keeps parse+serialize
idempotent without having to remember each value's original quoting style.

The parser understands only `key: value`, `key:`, `  - item`, and flow-list
lines. Anything else -- block scalars, nested maps, comments, anchors, tags,
duplicate keys -- raises `ValueError`, so a caller that rewrites notes (the
stamp hook) leaves the note untouched instead of destroying data.

Properties serialize in sorted key order, with exactly one blank line after
the closing `---`, no trailing whitespace on any line, and exactly one
trailing newline at end of file. Body content is never touched beyond that.

Both flow-style (`tags: [alpha, beta]`) and block-style (`tags:\n  - alpha`)
lists parse to the same `list[str]`; block style is the one canonical
serialized form, so normalizing a flow-style list rewrites it to block style.
A key with a truly blank value (`note:`, no following `  - ` item line) parses
as an empty scalar `""` and round-trips as `note:`; only the literal `[]`
parses as an empty list -- conflating the two would silently change a
property's type on every normalize.
"""

from __future__ import annotations

import re
from typing import Union

# Hook entry points run under the host's plain ``python3``.  macOS currently
# ships Python 3.9, where PEP 604's ``str | list[str]`` is not evaluable at
# module import time.  Keep this alias runtime-compatible without lowering the
# package's own ``requires-python`` declaration.
Property = Union[str, list[str]]  # noqa: UP007


class MissingFrontmatter(ValueError):
    """The text has no `---`-delimited frontmatter block at all."""


class UnsupportedFrontmatter(ValueError):
    """The block uses YAML this parser cannot represent without changing it."""


def _is_wikilink(value: str) -> bool:
    return value.startswith("[[") and value.endswith("]]")


# A plain (unquoted) scalar may not start with a YAML indicator, and ": " or
# " #" inside one ends it early. The parser refuses any such bare value, and
# the serializer quotes any value that matches, so the two stay inverse.
_YAML_INDICATORS = "[]{}&*!|>'\"%@`#,?:"
# `?` is valid inside a YAML 1.2 flow scalar, but PyYAML reads it as a key
# marker; refusing it keeps every parser agreeing with this one.
_FLOW_BREAKERS = "[]{},?"
_UNREPRESENTABLE = re.compile(r"[\x00-\x1f\x7f\x85\u2028\u2029]")


# Quoted text that bare YAML (1.2 core, or 1.1 as PyYAML reads it) would
# read as null, a bool, or a number. The
# serializer writes plain strings bare, and `parse` keeps no record of the
# original quotes, so it refuses these rather than change their type. Dates
# are left alone: YAML 1.2 reads a bare date as a string, and the daily
# template quotes `created`.
_TYPED_LOOKING = re.compile(
    r"~|null|Null|NULL|true|True|TRUE|false|False|FALSE"
    r"|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF"
    r"|[-+]?[0-9][0-9_]*|[-+]?0o[0-7_]+|[-+]?0x[0-9a-fA-F_]+|[-+]?0b[01_]+"
    r"|[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+(\.[0-9_]*)?"
    r"|[-+]?(\.[0-9_]+|[0-9][0-9_]*(\.[0-9_]*)?)([eE][-+]?[0-9]+)?"
    r"|[-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN)"
)


def _needs_quotes(value: str) -> bool:
    return (
        value == ""
        or value[0] in _YAML_INDICATORS
        or value.startswith("- ")
        or value == "-"
        or value.endswith(":")
        or value != value.strip()
        or ": " in value
        or " #" in value
    )


def _render(value: str) -> str:
    if _UNREPRESENTABLE.search(value):
        raise UnsupportedFrontmatter(
            f"value {value!r} contains a control character or line break, which "
            "this serializer cannot write"
        )
    if not _needs_quotes(value):
        return value
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _unsupported(line: str, reason: str) -> UnsupportedFrontmatter:
    return UnsupportedFrontmatter(
        f"unsupported frontmatter line {line!r} ({reason}); this parser refuses "
        "YAML it cannot represent rather than rewrite it"
    )


def _double_quoted(raw: str, line: str) -> str:
    """Decode `"..."`, allowing only the `\\` and `\"` escapes."""
    out: list[str] = []
    i = 1
    while i < len(raw):
        char = raw[i]
        if char == "\\":
            nxt = raw[i + 1 : i + 2]
            if nxt not in ("\\", '"'):
                raise _unsupported(line, f"escape \\{nxt} is not supported")
            out.append(nxt)
            i += 2
            continue
        if char == '"':
            if i != len(raw) - 1:
                raise _unsupported(line, "text after the closing quote")
            return "".join(out)
        out.append(char)
        i += 1
    raise _unsupported(line, "unterminated double quote")


def _single_quoted(raw: str, line: str) -> str:
    """Decode `'...'`, where `''` is the only escape."""
    out: list[str] = []
    i = 1
    while i < len(raw):
        if raw[i] == "'":
            if raw[i + 1 : i + 2] == "'":
                out.append("'")
                i += 2
                continue
            if i != len(raw) - 1:
                raise _unsupported(line, "text after the closing quote")
            return "".join(out)
        out.append(raw[i])
        i += 1
    raise _unsupported(line, "unterminated single quote")


def _scalar(raw: str, line: str, *, in_flow: bool = False) -> str:
    """Decode one scalar (a property value, list item, or flow element), or
    refuse it when YAML would read it as anything but that exact string."""
    if raw[:1] in ("'", '"'):
        value = _double_quoted(raw, line) if raw[0] == '"' else _single_quoted(raw, line)
        if value == "" or _TYPED_LOOKING.fullmatch(value):
            raise _unsupported(line, f"quoted {raw} would lose its quotes and change type")
        return value
    if _needs_quotes(raw):
        raise _unsupported(line, f"bare value {raw!r} is not a plain YAML string")
    if in_flow and any(char in _FLOW_BREAKERS for char in raw):
        raise _unsupported(line, f"flow element {raw!r} contains a flow indicator")
    return raw


def _split_flow_list(inner: str, line: str) -> list[str]:
    """Split a flow list's inner text on commas outside quotes, honoring the
    `\\` escape inside double quotes; one trailing comma is allowed."""
    raw_items: list[str] = []
    current: list[str] = []
    quote: str | None = None
    escaped = False
    for char in inner:
        current.append(char)
        if escaped:
            escaped = False
        elif quote == '"' and char == "\\":
            escaped = True
        elif quote is not None:
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == ",":
            current.pop()
            raw_items.append("".join(current).strip(" "))
            current = []
    if quote is not None:
        raise _unsupported(line, "unterminated quote in flow list")
    raw_items.append("".join(current).strip(" "))
    if raw_items[-1] == "" and len(raw_items) > 1:
        raw_items.pop()
    if any(item == "" for item in raw_items):
        raise _unsupported(line, "empty flow-list element")
    return [_scalar(item, line, in_flow=True) for item in raw_items]


def parse(text: str) -> tuple[dict[str, Property], str]:
    """Split `text` into (properties, body); raises if there is no frontmatter.

    Use when the note is known to require a frontmatter block -- a missing
    block is a real error, not something to paper over.
    Do NOT use when walking arbitrary vault files that may lack frontmatter
    -- use `llmos_vault.links.read_frontmatter`, which tolerates a bare body.

    Example output:
        ({'topics': ['gardening']}, '# Alpha\\n...')

    Example invocation:
        from llmos_vault.frontmatter import parse
        parse("---\\ntopics: gardening\\n---\\n\\n# Alpha\\n")

    Args:
        text: Full file text, frontmatter block plus body.

    Raises:
        MissingFrontmatter: The text has no `---`-delimited frontmatter block.
        UnsupportedFrontmatter: The block uses YAML this parser cannot
            represent exactly (block scalars, nested maps, comments, anchors,
            tags, escapes other than `\\` and `\"`, tabs, duplicate keys).
            Callers that rewrite notes must leave such a note untouched.
    """
    if not text.startswith("---\n"):
        raise MissingFrontmatter("note has no frontmatter block (must start with '---')")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise MissingFrontmatter("note's frontmatter block is never closed with '---'")
    body = text[end + len("\n---\n") :].lstrip("\n")

    properties: dict[str, Property] = {}
    block_list: list[str] | None = None
    # Split on "\n" only: `splitlines` would also split on form feeds and
    # other characters that YAML rejects outright.
    lines = text[4:end].split("\n")
    for i, line in enumerate(lines):
        if _UNREPRESENTABLE.search(line):
            raise _unsupported(line, "tab, carriage return, or control character")
        if not line.strip(" "):
            continue
        if line.startswith("  - "):
            if block_list is None:
                raise _unsupported(line, "list item not under a bare `key:` line")
            block_list.append(_scalar(line[4:].strip(" "), line))
            continue
        block_list = None
        key, colon, value = line.partition(":")
        if not colon or (value and not value.startswith(" ")) or not key or _needs_quotes(key):
            raise _unsupported(line, "not a `key: value` line")
        if key in properties:
            raise _unsupported(line, f"duplicate key {key!r}")
        value = value.strip(" ")
        if value.startswith("["):
            if not value.endswith("]"):
                raise _unsupported(line, "unterminated flow list")
            inner = value[1:-1].strip(" ")
            properties[key] = [] if not inner else _split_flow_list(inner, line)
        elif value == "":
            if i + 1 < len(lines) and lines[i + 1].startswith("  - "):
                block_list = []
                properties[key] = block_list
            else:
                properties[key] = ""
        else:
            properties[key] = _scalar(value, line)
    return properties, body


def serialize(properties: dict[str, Property], body: str) -> str:
    """Render `properties` + `body` as a normalized note (sorted keys, one
    blank line after `---`, no trailing whitespace, one trailing newline).

    Use when writing a note back to disk after changing its properties or
    body -- every mutation path renders through this so the file stays in
    the vault's one canonical shape.
    Do NOT use when you have raw file text, not parsed properties/body --
    call `parse` (or `read_frontmatter`) first.

    Example output:
        '---\\ntopics:\\n  - gardening\\n---\\n\\n# Alpha\\n'

    Example invocation:
        from llmos_vault.frontmatter import serialize
        serialize({"topics": ["gardening"]}, "# Alpha\\n")

    Args:
        properties: Frontmatter properties to render.
        body: Note body text.
    """
    lines = ["---"]
    for key in sorted(properties):
        value = properties[key]
        if isinstance(value, list):
            if not value:
                lines.append(f"{key}: []")
                continue
            lines.append(f"{key}:")
            for item in value:
                if item == "":
                    # `parse` refuses `  - ""` (bare YAML reads it as null), so
                    # writing one would produce a note nothing can re-read.
                    raise UnsupportedFrontmatter(f"empty item in list property {key!r}")
                lines.append(f"  - {_render(item)}")
        elif value == "":
            lines.append(f"{key}:")
        else:
            lines.append(f"{key}: {_render(value)}")
    lines.append("---")
    lines.append("")

    body_lines = [line.rstrip() for line in body.splitlines()]
    while body_lines and body_lines[-1] == "":
        body_lines.pop()

    return "\n".join(lines + body_lines) + "\n"


def normalize(text: str) -> str:
    """Parse then re-serialize `text`, fixing key order, blank line, trailing
    whitespace, and trailing newline. Idempotent: normalize(normalize(x)) ==
    normalize(x).

    Use when a hook or CLI verb needs to re-format a note's frontmatter
    without changing any property values -- the PostToolUse stamp/format hook
    calls this on every vault write.
    Do NOT use when you also need to change a property's value -- parse,
    mutate with `set_scalar`/`append_unique`, then `serialize` instead.

    Example output:
        '---\\ntopics:\\n  - gardening\\n---\\n\\n# Alpha\\n'

    Example invocation:
        from llmos_vault.frontmatter import normalize
        normalize("---\\ntopics: gardening\\n---\\n# Alpha")

    Args:
        text: Full file text, frontmatter block plus body.
    """
    properties, body = parse(text)
    return serialize(properties, body)


def set_scalar(properties: dict[str, Property], key: str, value: str) -> dict[str, Property]:
    """Set a scalar property in place. `created` is immutable -- it is never
    rewritten.

    Use when a verb needs to overwrite a single-value property -- e.g.
    stamping `updated` to today's date.
    Do NOT use when the property is a list you want to add to, not replace
    -- use `append_unique`, which preserves existing entries.

    Example output:
        {'updated': '2026-07-17', 'topics': ['gardening']}

    Example invocation:
        from llmos_vault.frontmatter import set_scalar
        set_scalar({"topics": ["gardening"]}, "updated", "2026-07-17")

    Args:
        properties: Frontmatter properties to mutate.
        key: Property name to set.
        value: New scalar value.

    Raises:
        ValueError: `key` is "created" -- that property is never rewritten.
    """
    if key == "created":
        raise ValueError("created is immutable and must never be rewritten")
    properties[key] = value
    return properties


def append_unique(properties: dict[str, Property], key: str, value: str) -> dict[str, Property]:
    """Append `value` to the list property `key` in place, unless already present.

    Use when a verb needs to add to a list property without duplicating an
    existing entry -- e.g. appending the current provider to `authors`.
    Do NOT use when the property holds a single scalar value you want to
    replace -- use `set_scalar` instead.

    Example output:
        {'authors': ['claude', 'codex']}

    Example invocation:
        from llmos_vault.frontmatter import append_unique
        append_unique({"authors": ["claude"]}, "authors", "codex")

    Args:
        properties: Frontmatter properties to mutate.
        key: List property name to append to.
        value: Value to append if not already present.
    """
    existing = properties.get(key, [])
    if not isinstance(existing, list):
        existing = [existing]
    if value not in existing:
        existing.append(value)
    properties[key] = existing
    return properties
