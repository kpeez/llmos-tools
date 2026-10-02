#!/usr/bin/env python3
"""PostToolUse hook: normalize, stamp, and check vault markdown notes.

One process: normalizes frontmatter, stamps `updated` with today's date,
appends the invoking provider to `authors` if detectable and absent, and
flags the qmd collection dirty for the Stop hook (`llmos_qmd_hook.py`) to
consume. Non-vault writes and notes without a frontmatter block are left
untouched. File resolution (vault root, symlinks, Codex's `apply_patch`
envelope) is imported from `llmos_hook.py`, not reimplemented. Failures never
block the tool call (same fail-silent contract as `llmos_hook.py`).
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS_DIR.parent))  # llmos_vault package

from llmos_dirty_flag import flag_path  # noqa: E402
from llmos_hook import (  # noqa: E402
    _emit,
    _is_under,
    _read_payload,
    _resolved_root,
    _target_paths,
)

from llmos_vault import frontmatter  # noqa: E402
from llmos_vault.provider import detect_provider  # noqa: E402

COLLECTION = "llmos"


def stamp_vault_note(path: Path, provider: str | None) -> None:
    text = path.read_text(encoding="utf-8")
    properties, body = frontmatter.parse(text)
    frontmatter.set_scalar(properties, "updated", date.today().isoformat())
    if provider:
        frontmatter.append_unique(properties, "authors", provider)
    path.write_text(frontmatter.serialize(properties, body), encoding="utf-8")


def _authoring_diagnostics(root: Path, paths: list[Path]) -> str | None:
    """Return concise guidance from the shared checker; never edit or block."""
    try:
        from llmos_vault.authoring import check_notes

        checks = check_notes(root, paths)
    except (ImportError, OSError, ValueError):
        return None

    lines: list[str] = []
    max_findings = 8
    for check in checks:
        for finding in check.findings:
            location = f":{finding.line}" if finding.line else ""
            target = f" -> {finding.target}" if finding.target else ""
            message = " ".join(str(finding.message).split())
            line = f"{check.path}{location} [{finding.code}]{target}: {message}"
            if len(line) > 240:
                line = line[:237].rstrip() + "..."
            lines.append(line)
            if len(lines) >= max_findings:
                break
        if len(lines) >= max_findings:
            break

    if not lines:
        return None
    return (
        "llmOS authoring check (informational; this checker did not block the "
        "write or rewrite note content):\n"
        + "\n".join(lines)
        + "\nRun `llmos-vault check <note>` for complete findings."
    )


def post_tool_use(data: dict) -> str | None:
    root = _resolved_root()
    if root is None:
        return None
    tool_input = data.get("tool_input") or data.get("input") or {}
    if not isinstance(tool_input, dict):
        return None
    targets = _target_paths(
        tool_input,
        cwd=data.get("cwd"),
        tool_name=data.get("tool_name") or "",
        root=root,
    )
    vault_targets = [
        target
        for target in targets
        if _is_under(target, root) and target.suffix.lower() == ".md" and target.is_file()
    ]
    if not vault_targets:
        return None
    provider = detect_provider()
    stamped = False
    for target in vault_targets:
        try:
            stamp_vault_note(target, provider)
            stamped = True
        except ValueError:
            continue  # no frontmatter block: nothing to normalize or stamp
    if stamped:
        session_id = data.get("session_id") or "default"
        flag_path(session_id, COLLECTION).touch()
    return _authoring_diagnostics(root, vault_targets)


def main() -> None:
    try:
        output = post_tool_use(_read_payload())
    except Exception:
        return  # hook failure must never block the tool call
    if output:
        print(_emit("post-tool-use", output))


if __name__ == "__main__":
    main()
