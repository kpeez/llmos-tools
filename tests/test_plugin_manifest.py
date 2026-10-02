"""The plugin's static config must stay shaped the way both harnesses expect.

These replace the vault suite's HookConfigTests, which asserted the same
invariants against the retired agents/claude/settings.template.json and
agents/codex/hooks.json payloads.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def _hook_commands() -> list[str]:
    hooks = json.loads((PLUGIN_ROOT / "hooks" / "hooks.json").read_text())["hooks"]
    return [
        entry["command"]
        for event in hooks.values()
        for matcher in event
        for entry in matcher["hooks"]
    ]


def test_codex_manifest_omits_hooks_key() -> None:
    # Codex manifest validation rejects a "hooks" key; hooks are auto-discovered.
    manifest = json.loads((PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text())
    assert "hooks" not in manifest


def test_hooks_declare_session_start_and_pre_tool_use() -> None:
    hooks = json.loads((PLUGIN_ROOT / "hooks" / "hooks.json").read_text())["hooks"]
    assert set(hooks) == {"SessionStart", "PreToolUse", "PostToolUse", "Stop"}
    pre_tool_matchers = [entry["matcher"] for entry in hooks["PreToolUse"]]
    post_tool_matchers = [entry["matcher"] for entry in hooks["PostToolUse"]]
    pre_tool_names = (
        "Read",
        "Write",
        "Edit",
        "MultiEdit",
        "Grep",
        "Glob",
        "LS",
        "apply_patch",
        "Bash",
    )
    for tool_name in pre_tool_names:
        assert any(re.fullmatch(matcher, tool_name) for matcher in pre_tool_matchers), tool_name
    for tool_name in ("Write", "Edit", "MultiEdit", "apply_patch"):
        assert any(re.fullmatch(matcher, tool_name) for matcher in post_tool_matchers), tool_name
    assert not any(re.fullmatch(matcher, "TaskCreate") for matcher in pre_tool_matchers)


def test_hook_commands_use_the_plugin_root_variable() -> None:
    # Neither harness string-substitutes shell-form commands: both export
    # CLAUDE_PLUGIN_ROOT and let a shell expand it. Codex uses the login shell,
    # where fish rejects ${VAR} outright, so commands must use the "$VAR" form.
    commands = _hook_commands()
    assert commands
    assert all('"$CLAUDE_PLUGIN_ROOT"/' in command for command in commands)
    assert not any("${CLAUDE_PLUGIN_ROOT}" in command for command in commands)
    assert not any("CODEX_PLUGIN_ROOT" in command for command in commands)
