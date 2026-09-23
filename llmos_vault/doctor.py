"""Check the external prerequisites used by the llmOS maintenance workflow."""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path


def _run(command: list[str]) -> tuple[int, str]:
    timeout = float(os.environ.get("LLMOS_DOCTOR_TIMEOUT", "30"))
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, f"{Path(command[0]).name} timed out after {timeout:g}s"
    output = result.stdout
    if result.stderr:
        output += result.stderr
    return result.returncode, output.rstrip("\n")


def _root_from_config(config_path: Path) -> str:
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return ""
    value = data.get("vault_root") if isinstance(data, dict) else None
    return value if isinstance(value, str) else ""


def _resolved_root() -> Path | None:
    # Match the canonical resolver: an empty environment variable is unset,
    # so an existing config remains usable after shell export mistakes.
    root_input = os.environ.get("LLMOS_ROOT")
    if not root_input:
        root_input = _root_from_config(Path.home() / ".config" / "llmos" / "config.json")
    if not root_input:
        return None
    root = Path(root_input).expanduser()
    try:
        root = root.resolve()
    except OSError:
        pass
    return root


def _qmd_content(output: str) -> str:
    """Remove qmd's URI header while retaining the retrieved note."""
    if not output.startswith("qmd://"):
        return output
    lines = output.splitlines()
    separators = [index for index, line in enumerate(lines) if line == "---"]
    if len(separators) >= 2:
        return "\n".join(lines[separators[1] :])
    if separators:
        return "\n".join(lines[separators[0] :])
    return "\n".join(lines[1:]).lstrip("\n")


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()
    failures = 0
    root_repair = (
        'Run /setup-llmos, or set it manually: export LLMOS_ROOT="/absolute/path/to/llmOS"'
    )
    qmd_repair = "npm install -g @tobilu/qmd"

    system = os.environ.get("LLMOS_DOCTOR_OS", platform.system())
    if system == "Darwin":
        platform_name = "macos"
        obsidian_repair = (
            "brew install --cask obsidian && ln -sfh "
            '"/Applications/Obsidian.app/Contents/MacOS/obsidian-cli" '
            '"$(brew --prefix)/bin/obsidian-cli"'
        )
    elif system == "Linux":
        platform_name = "linux"
        obsidian_repair = (
            'sudo snap install obsidian --classic && mkdir -p "$HOME/.local/bin" && '
            'ln -sf /snap/obsidian/current/app/obsidian-cli "$HOME/.local/bin/obsidian-cli"'
        )
    else:
        print("FAIL platform: setup-llmos supports macOS and Linux only")
        return 1

    root = _resolved_root()
    if root is None:
        print("FAIL vault-root: llmOS root is not configured")
        print(f"REPAIR {root_repair}")
        failures += 1
        root_valid = False
        resolved_root = ""
    else:
        resolved_root = str(root)
        if (root / ".obsidian").is_dir() and (root / "AGENTS.md").is_file():
            root_valid = True
            print(f"PASS vault-root: {resolved_root}")
        else:
            print(
                f"FAIL vault-root: {resolved_root} is not an llmOS vault with "
                ".obsidian/ and AGENTS.md"
            )
            print(f"REPAIR {root_repair}")
            failures += 1
            root_valid = False

    obsidian_app_repair = (
        f'open -a Obsidian "{resolved_root}"'
        if platform_name == "macos"
        else f'obsidian "{resolved_root}"'
    )
    obsidian_cli = shutil.which("obsidian-cli")
    if obsidian_cli:
        print(f"PASS obsidian-cli: {obsidian_cli}")
    else:
        print("FAIL obsidian-cli: command not found")
        print(f"REPAIR {obsidian_repair}")
        failures += 1

    if obsidian_cli and root_valid:
        code, output = _run([obsidian_cli, "vault=llmOS", "read", "path=llmOS.md"])
        sentinel = Path(resolved_root, "llmOS.md")
        expected = sentinel.read_text(encoding="utf-8") if sentinel.is_file() else None
        if code == 0 and expected is not None and output + "\n" == expected:
            print("PASS obsidian-vault: read canonical llmOS.md")
        else:
            detail = (
                f"llmOS.md content does not match {resolved_root}/llmOS.md"
                if code == 0
                else f"Obsidian app or vault llmOS is unavailable: {output}"
            )
            print(f"FAIL obsidian-vault: {detail}")
            print(f"REPAIR {obsidian_app_repair}")
            if platform_name == "linux":
                print("NOTE enable Settings > General > Advanced > Command line interface")
            failures += 1
    else:
        print("FAIL obsidian-vault: blocked by vault-root or obsidian-cli failure")
        print(f"REPAIR {root_repair if not root_valid else obsidian_repair}")
        failures += 1

    qmd_cli = shutil.which("qmd")
    if qmd_cli:
        print(f"PASS qmd: {qmd_cli}")
    else:
        print("FAIL qmd: command not found")
        print(f"REPAIR {qmd_repair}")
        failures += 1

    collection_matches = False
    collection_repair = qmd_repair
    if qmd_cli and root_valid:
        code, output = _run([qmd_cli, "collection", "show", "llmos"])
        match = re.search(r"^\s*Path:\s*(.*)$", output, flags=re.MULTILINE)
        collection_path = match.group(1).strip() if match else ""
        collection_root = (
            str(Path(collection_path).resolve())
            if collection_path and Path(collection_path).is_dir()
            else collection_path
        )
        if code == 0 and collection_root and collection_root == resolved_root:
            collection_matches = True
            print(f"PASS qmd-collection: llmos -> {collection_root}")
        elif code == 0:
            print(
                "FAIL qmd-collection: llmos points to "
                f"{collection_root or 'an unreadable path'}, expected {resolved_root}"
            )
            collection_repair = (
                f'qmd collection remove llmos && qmd collection add "{resolved_root}" --name llmos'
            )
            print(f"REPAIR {collection_repair}")
            failures += 1
        else:
            print(f"FAIL qmd-collection: llmos collection is missing: {output}")
            collection_repair = f'qmd collection add "{resolved_root}" --name llmos'
            print(f"REPAIR {collection_repair}")
            failures += 1
    else:
        print("FAIL qmd-collection: blocked by vault-root or qmd failure")
        collection_repair = root_repair if not root_valid else qmd_repair
        print(f"REPAIR {collection_repair}")
        failures += 1

    if collection_matches:
        assert qmd_cli is not None
        code, output = _run([qmd_cli, "ls", "llmos/llmOS.md"])
        indexed = (
            code == 0
            and ("qmd://llmos/llmOS.md" in output or "qmd://llmos/llmos.md" in output)
            and "no files found" not in output.lower()
        )
        if indexed:
            print("PASS qmd-index: llmOS.md is indexed")
        else:
            print("FAIL qmd-index: llmOS.md is stale or unindexed")
            print("REPAIR qmd update")
            failures += 1

        code, output = _run([qmd_cli, "get", "qmd://llmos/llmOS.md", "--no-line-numbers"])
        sentinel = Path(resolved_root, "llmOS.md")
        expected = sentinel.read_text(encoding="utf-8") if sentinel.is_file() else None
        if (
            code == 0
            and expected is not None
            and _qmd_content(output).rstrip("\n") == expected.rstrip("\n")
        ):
            print("PASS qmd-retrieval: full llmOS.md matches the vault")
        else:
            print("FAIL qmd-retrieval: retrieved llmOS.md does not match the vault sentinel")
            print("REPAIR qmd update")
            failures += 1
    else:
        print("FAIL qmd-index: blocked by qmd-collection failure")
        print(f"REPAIR {collection_repair}")
        failures += 1
        print("FAIL qmd-retrieval: blocked by qmd-collection failure")
        print(f"REPAIR {collection_repair}")
        failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
