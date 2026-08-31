"""Prove write_config.py validates before writing (ADR-0001): a rejected
path must leave the config file untouched, never pointing at a non-vault."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).parent / "write_config.py"
SYSTEM_PYTHON = Path("/usr/bin/python3")
if not SYSTEM_PYTHON.is_file():
    SYSTEM_PYTHON = Path(sys.executable)
_spec = importlib.util.spec_from_file_location("write_config", MODULE_PATH)
assert _spec is not None and _spec.loader is not None
write_config_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(write_config_module)


def make_vault(root: Path) -> Path:
    (root / ".obsidian").mkdir(parents=True)
    (root / "AGENTS.md").write_text("# fake vault\n")
    return root


def test_documented_command_writes_config_with_system_python(tmp_path):
    vault = make_vault(tmp_path / "vault")
    config_path = tmp_path / ".config" / "llmos" / "config.json"
    env = os.environ.copy()
    env["HOME"] = str(tmp_path)
    env.pop("PYTHONPATH", None)

    result = subprocess.run(
        [str(SYSTEM_PYTHON), str(MODULE_PATH), str(vault)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    written = json.loads(config_path.read_text())
    assert written == {"vault_root": str(vault.resolve())}


def test_rejects_a_non_vault_and_writes_nothing(tmp_path, monkeypatch):
    not_a_vault = tmp_path / "just-a-folder"
    not_a_vault.mkdir()
    config_path = tmp_path / "config" / "config.json"
    monkeypatch.setattr(write_config_module.vault_root, "CONFIG_PATH", config_path)

    with pytest.raises(SystemExit) as exc_info:
        write_config_module.write_config(not_a_vault)

    assert "not a valid vault" in str(exc_info.value)
    assert not config_path.exists()
