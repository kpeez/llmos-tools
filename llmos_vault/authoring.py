"""Read-only, conservative checks for connections missing from note prose.

This is an authoring aid, not an Obsidian renderer or a general Markdown
validator. Only an explicit .md reference that resolves to an existing note
earns a finding. Concepts, link quotas, and unresolved future notes require
the author's judgment.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

from llmos_vault.links import VaultIndex, build_index, extract_wikilinks, read_frontmatter

WIKI = re.compile(r"!?\[\[([^\]\n]+)\]\]")
MARKDOWN_LINK = re.compile(r"!?\[[^\]\n]*\]\(([^)\n]+)\)")
INLINE_CODE = re.compile(r"(`+)(.+?)\1")
NOTE_PATH = re.compile(r"(?<![\w/\\.:])(?:[\w.-]+/)*[\w.-]+\.md(?![\w])")
CODE_PATH = re.compile(r"[\w .\-/]+\.md")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
COMMENTS = re.compile(r"<!--.*?-->|%%.*?%%", re.DOTALL)
URL = re.compile(r"\b[a-zA-Z][\w+.-]*://[^\s<>]+")


@dataclass(frozen=True)
class Finding:
    code: str
    line: int
    target: str
    message: str


@dataclass(frozen=True)
class NoteCheck:
    path: str
    body_links: list[str]
    property_links: list[str]
    findings: list[Finding]


def _blank(text: str) -> str:
    return re.sub(r"[^\n]", " ", text)


def _prose(body: str) -> str:
    """Hide examples and comments while retaining offsets for line numbers."""
    result: list[str] = []
    fence: str | None = None
    list_content_indents: list[int] = []
    for line in body.splitlines(keepends=True):
        expanded = line.expandtabs(4)
        indent = len(expanded) - len(expanded.lstrip())
        item = LIST_ITEM.match(expanded)
        if line.strip() and fence is None:
            while list_content_indents and indent < list_content_indents[-1]:
                list_content_indents.pop()
        nested_item = (
            item is not None
            and bool(list_content_indents)
            and indent < list_content_indents[-1] + 4
        )
        match = FENCE.match(line)
        if fence is not None:
            result.append(_blank(line))
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence):
                fence = None
        elif match:
            fence = match[1]
            result.append(_blank(line))
        elif indent >= 4 and not nested_item:
            result.append(_blank(line))
        else:
            result.append(line)
            if item:
                list_content_indents.append(item.end())
    return COMMENTS.sub(lambda m: _blank(m[0]), "".join(result))


def _existing_note(index: VaultIndex, source: Path, reference: str) -> Path | None:
    """Resolve local and vault paths first; only unique basenames may fall back."""
    for base in (source.parent, index.root):
        candidate = (base / reference).resolve()
        if candidate.is_relative_to(index.root) and candidate in index.paths:
            return candidate
    if "/" in reference or "\\" in reference:
        return None
    matches = index.by_stem.get(reference.removesuffix(".md").lower(), [])
    return matches[0] if len(matches) == 1 else None


def _body_links(prose: str) -> list[str]:
    prose = INLINE_CODE.sub(lambda m: _blank(m[0]), prose)
    targets = extract_wikilinks(prose)
    for match in MARKDOWN_LINK.finditer(prose):
        destination = match[1].strip().split(" ", 1)[0].strip("<>")
        if re.match(r"^[a-zA-Z][\w+.-]*:", destination):
            continue
        target = unquote(destination).split("#", 1)[0]
        if target.endswith(".md"):
            targets.append(target.removesuffix(".md"))
    return sorted(set(targets))


def check_notes(root: Path, paths: list[Path]) -> list[NoteCheck]:
    """Check explicit note references and separate prose links from properties.

    Used by `llmos-vault check` and the post-write hook. Findings request
    review; they never rewrite notes. Known filenames in inline code and
    prose are checked, while fenced/indented code, commands in inline code,
    comments, URLs, existing links, missing files, and ambiguous names are
    left alone. The first unlinked occurrence of each target is reported.

    Args:
        root: Configured vault root.
        paths: Markdown files in the vault, including symlinked absolute paths.
    """
    root = root.resolve()
    index = build_index(root)
    checks: list[NoteCheck] = []
    for supplied in paths:
        path = supplied.resolve()
        if not path.is_relative_to(root) or path.suffix != ".md" or not path.is_file():
            raise ValueError(f"not a Markdown note in this vault: {supplied}")
        text = path.read_text(encoding="utf-8")
        properties, body = read_frontmatter(path)
        line_offset = text[: len(text) - len(body)].count("\n")
        prose = _prose(body)
        body_links = _body_links(prose)
        property_links = sorted(
            {
                target
                for value in properties.values()
                for item in (value if isinstance(value, list) else [value])
                for target in extract_wikilinks(item)
            }
        )

        candidates: list[tuple[int, str]] = []
        # Existing links are not missing navigation, regardless of link style.
        unlinked = WIKI.sub(lambda m: _blank(m[0]), prose)
        unlinked = MARKDOWN_LINK.sub(lambda m: _blank(m[0]), unlinked)
        unlinked = URL.sub(lambda m: _blank(m[0]), unlinked)
        for match in INLINE_CODE.finditer(unlinked):
            literal = match[2].strip()
            if CODE_PATH.fullmatch(literal):
                candidates.append((match.start(), literal))
        unlinked = INLINE_CODE.sub(lambda m: _blank(m[0]), unlinked)
        candidates.extend((m.start(), m[0]) for m in NOTE_PATH.finditer(unlinked))

        seen: set[Path] = set()
        findings: list[Finding] = []
        for offset, reference in sorted(candidates):
            target_path = _existing_note(index, path, reference)
            if target_path is None or target_path == path or target_path in seen:
                continue
            seen.add(target_path)
            target = target_path.relative_to(root).as_posix().removesuffix(".md")
            findings.append(
                Finding(
                    code="unlinked-note",
                    line=line_offset + body[:offset].count("\n") + 1,
                    target=target,
                    message=(
                        f"Existing note reference {reference!r}: link to {target!r} "
                        "using the note title or a natural phrase, not the filename."
                    ),
                )
            )
        checks.append(
            NoteCheck(
                path=path.relative_to(root).as_posix(),
                body_links=body_links,
                property_links=property_links,
                findings=findings,
            )
        )
    return checks
