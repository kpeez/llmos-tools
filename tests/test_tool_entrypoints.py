"""Exercise each installed maintenance command through its real executable."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

COMMANDS = ("llmos-vault", "llmos-audit", "llmos-daily-activity", "llmos-doctor")
PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def installed_command(name: str) -> Path:
    """Resolve the console-script sibling of the test interpreter."""
    return Path(sys.executable).with_name(name)


def run_command(
    name: str,
    *arguments: str,
    home: Path,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["HOME"] = str(home)
    env.pop("LLMOS_ROOT", None)
    env.pop("PYTHONPATH", None)
    return subprocess.run(
        [str(installed_command(name)), *arguments],
        cwd=PLUGIN_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_each_console_script_runs_from_the_installed_environment(tmp_path: Path) -> None:
    for name in COMMANDS:
        result = run_command(name, "--help", home=tmp_path)

        assert result.returncode == 0, f"{name}: {result.stdout}{result.stderr}"
        assert result.stdout.strip(), name


def test_doctor_entrypoint_reports_an_unconfigured_root(tmp_path: Path) -> None:
    result = run_command(
        "llmos-doctor",
        home=tmp_path,
    )

    assert result.returncode == 1
    assert "FAIL vault-root: llmOS root is not configured" in result.stdout
    assert "REPAIR Run /setup-llmos" in result.stdout
