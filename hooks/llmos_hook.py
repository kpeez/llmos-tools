#!/usr/bin/env python3
"""Gated llmOS context hooks for session start and common note access tools.

The configured vault root is the only authority for vault identity. Session
startup recognizes either a cwd inside that root or a project cwd whose
ancestor has an `.agents/docs` or `.agent/docs` symlink into that root.
PreToolUse resolves explicit paths through symlinks before deciding whether
to inject the canonical authoring guidance. Shell coverage is intentionally
limited to simple, standalone read commands; it is not a shell parser.

Hook failures are fail-silent and must never block the tool call. No provider
MEMORY.md is read (ADR-0003).
"""

from __future__ import annotations

import json
import shlex
import sys
from datetime import date
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS_DIR.parent / "scripts"))

NOTE_SUFFIXES = {".md", ".base", ".canvas"}
MARKDOWN_SUFFIX = ".md"
PATCH_VERBS = ("*** Update File:", "*** Add File:", "*** Delete File:")
SHELL_READERS = {"cat", "head", "tail", "sed", "rg", "grep"}
VAULT_READ_COMMANDS = {"read", "list", "check", "neighbors", "subgraph", "health"}
MAX_AUTHORING_CONTEXT_CHARS = 8_000


def _read_payload() -> dict:
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _is_under(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _resolved_root() -> Path | None:
    """Configured vault root, or None; never lets setup errors block tools."""
    try:
        from vault_root import vault_root
    except ImportError:
        return None
    try:
        return vault_root().resolve()
    except (SystemExit, OSError, RuntimeError):
        return None


def _path_from(value: object, cwd: object = None) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(value).expanduser()
    if not path.is_absolute():
        base = Path(cwd).expanduser() if isinstance(cwd, str) and cwd else Path.cwd()
        path = base / path
    try:
        return path.resolve()
    except OSError:
        return None


def _linked_project_docs(cwd: Path, root: Path) -> tuple[Path, Path] | None:
    """Return the linked docs path and target for a cwd inside a project repo."""
    for ancestor in (cwd, *cwd.parents):
        for dot_directory in (".agents", ".agent"):
            candidate = ancestor / dot_directory / "docs"
            try:
                if not candidate.is_dir():
                    continue
                target = candidate.resolve(strict=True)
                has_symlink = candidate.is_symlink() or candidate.parent.is_symlink()
                if has_symlink and _is_under(target, root):
                    return candidate, target
            except (OSError, RuntimeError):
                continue
    return None


def _session_context(root: Path, linked: tuple[Path, Path] | None) -> str:
    routes = (
        f"For durable vault work, read {root / 'AGENTS.md'}, "
        f"{root / 'agents' / 'references' / 'schema.md'}, and "
        f"{root / 'agents' / 'references' / 'authoring.md'}."
    )
    if linked:
        linked_path, target = linked
        access = (
            f"This project session reaches llmOS through {linked_path} "
            f"(resolves to {target}). Treat those files as Obsidian vault notes. "
        )
    else:
        access = f"llmOS root: {root}. "
    today = date.today().isoformat()
    daily = (
        f"Insight worth keeping goes under ## Thoughts in "
        f"{root / 'reviews' / 'daily' / f'{today}.md'} -- prose only, and never a "
        "restatement of commits, issues, or PRs, which GitHub already records."
    )
    return f"{access}{routes}\n{daily}"


def session_start(data: dict) -> str | None:
    root = _resolved_root()
    if root is None:
        return None
    cwd = _path_from(data.get("cwd")) or Path.cwd().resolve()
    linked = None if _is_under(cwd, root) else _linked_project_docs(cwd, root)
    if not _is_under(cwd, root) and linked is None:
        return None
    return _session_context(root, linked)


def _is_note(path: Path) -> bool:
    return path.suffix.lower() in NOTE_SUFFIXES


def _is_write_tool(tool_name: str) -> bool:
    return tool_name in {"Write", "Edit", "MultiEdit", "apply_patch"}


def _patch_paths(command: str) -> list[str]:
    return [
        line.split(":", 1)[1].strip()
        for line in command.splitlines()
        if line.startswith(PATCH_VERBS)
    ]


def _simple_shell_paths(command: str, root: Path) -> list[str]:
    """Extract explicit paths from a small allowlist of simple shell reads.

    Compound commands and shell expansion are ignored. This is deliberately
    incomplete: parsing arbitrary shell syntax here would be unreliable.
    """
    if any(marker in command for marker in ("\n", ";", "|", "&", ">", "<", "`", "$(", "${")):
        return []
    try:
        tokens = shlex.split(command)
    except ValueError:
        return []
    if not tokens:
        return []

    executable = Path(tokens[0]).name
    args = tokens[1:]
    if executable == "llmos-vault":
        if args[:1] == ["daily"]:
            if args[1:2] != ["recent"]:
                return []
        elif not args or args[0] not in VAULT_READ_COMMANDS:
            return []
        vault_name = "llmos"
        for index, argument in enumerate(args):
            if argument == "--vault":
                if index + 1 < len(args):
                    vault_name = args[index + 1]
                break
            if argument.startswith("--vault="):
                vault_name = argument.split("=", 1)[1]
                break
        return [str(root)] if vault_name == "llmos" else []
    if executable not in SHELL_READERS:
        return []

    positional = [argument for argument in args if not argument.startswith("-")]
    # rg/grep take the search expression before their optional path arguments.
    if executable in {"rg", "grep"}:
        if "--files" not in args:
            positional = positional[1:]
    return positional


def _target_paths(
    tool_input: dict,
    *,
    cwd: object = None,
    tool_name: str = "",
    root: Path | None = None,
) -> list[Path]:
    """Extract and resolve explicit paths from supported harness payloads."""
    raw_paths: list[str] = []
    for key in ("file_path", "path", "notebook_path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            raw_paths.append(value)
    command = tool_input.get("command")
    if isinstance(command, str):
        raw_paths.extend(_patch_paths(command))
        if tool_name == "Bash" and root is not None:
            raw_paths.extend(_simple_shell_paths(command, root))
    return [path for value in raw_paths if (path := _path_from(value, cwd)) is not None]


def _authoring_context(root: Path) -> str:
    authoring = root / "agents" / "references" / "authoring.md"
    if not authoring.is_file():
        return (
            "llmOS notes are Obsidian notes: use [[wikilinks]] for internal links, "
            "connect new notes to relevant existing notes, and use Bases or Canvas "
            "when they improve browsing. See the canonical authoring contract at "
            f"{authoring}."
        )
    try:
        text = authoring.read_text(encoding="utf-8").strip()
    except OSError:
        return f"Follow the canonical llmOS authoring contract at {authoring}."
    if len(text) > MAX_AUTHORING_CONTEXT_CHARS:
        text = text[:MAX_AUTHORING_CONTEXT_CHARS].rstrip() + "\n[authoring guidance truncated]"
    return f"Canonical llmOS Obsidian authoring guidance ({authoring}):\n{text}"


def _read_context(root: Path) -> str:
    authoring = root / "agents" / "references" / "authoring.md"
    return (
        "This is an Obsidian vault note. Preserve its frontmatter, wikilinks, "
        "embeds, and local context. Use `llmos-vault read`/`neighbors` or qmd "
        "for retrieval. Before editing, use `maintain-llmos`/`vault-cli` when "
        f"available and check {authoring}."
    )


def _write_context(root: Path, targets: list[Path]) -> str:
    context = _authoring_context(root)
    skill_names = {
        ".md": "obsidian-markdown",
        ".base": "obsidian-bases",
        ".canvas": "json-canvas",
    }
    relevant_skills = sorted(
        {
            skill_names[target.suffix.lower()]
            for target in targets
            if target.suffix.lower() in skill_names
        }
    )
    routing = (
        "Use `maintain-llmos`/`vault-cli` when available; use the installed "
        "Obsidian skill for the file type when available: "
        + ", ".join(f"`{name}`" for name in relevant_skills)
        + "."
    )
    return f"{context}\n\n{routing}"


def _tool_name(data: dict) -> str:
    name = data.get("tool_name") or data.get("name") or ""
    return name if isinstance(name, str) else ""


def pre_tool_use(data: dict) -> str | None:
    root = _resolved_root()
    if root is None:
        return None
    tool_input = data.get("tool_input") or data.get("input") or {}
    if not isinstance(tool_input, dict):
        return None
    tool_name = _tool_name(data)
    targets = _target_paths(
        tool_input,
        cwd=data.get("cwd"),
        tool_name=tool_name,
        root=root,
    )
    relevant = [
        target
        for target in targets
        if _is_under(target, root)
        and (_is_note(target) or (tool_name in {"Grep", "Glob", "LS", "Bash"} and target.is_dir()))
    ]
    if not relevant:
        return None

    # The empty name fallback preserves support for older Codex payloads that
    # include a path but omit tool_name; their path shape is the write target.
    write_intent = _is_write_tool(tool_name) or not tool_name
    context = _write_context(root, relevant) if write_intent else _read_context(root)
    if write_intent and any(target.suffix.lower() == MARKDOWN_SUFFIX for target in relevant):
        schema = root / "agents" / "references" / "schema.md"
        if schema.is_file():
            try:
                context = f"{schema.read_text(encoding='utf-8').strip()}\n\n{context}"
            except OSError:
                pass
    return context


EVENTS = {"session-start": session_start, "pre-tool-use": pre_tool_use}


def _emit(event: str, output: str) -> str:
    """Render output on the channel consumed by the corresponding hook event."""
    if event == "session-start":
        return output
    event_name = "PostToolUse" if event == "post-tool-use" else "PreToolUse"
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": event_name,
                "additionalContext": output,
            }
        }
    )


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in EVENTS:
        return
    handler = EVENTS[sys.argv[1]]
    try:
        output = handler(_read_payload())
    except Exception:
        return  # hook failure must never block the tool call
    if output:
        print(_emit(sys.argv[1], output))


if __name__ == "__main__":
    main()
