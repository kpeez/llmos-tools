#!/usr/bin/env python3
"""Generate the Claude and Codex catalogs at the llmos repository root.

The plugin lives in tools/; both harnesses read their catalog from the root.
"""

from __future__ import annotations

import json
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parent
CLAUDE_MARKETPLACE = REPO_ROOT / ".claude-plugin" / "marketplace.json"
AGENTS_MARKETPLACE = REPO_ROOT / ".agents" / "plugins" / "marketplace.json"
PLUGIN_MANIFEST = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
PLUGIN_SOURCE = "./" + PLUGIN_ROOT.name

DEFAULT_POLICY = {"installation": "AVAILABLE", "authentication": "ON_USE"}
DEFAULT_CATEGORY = "Productivity"


def catalogs() -> tuple[dict, dict]:
    manifest = json.loads(PLUGIN_MANIFEST.read_text())
    plugin_name = manifest["name"]
    marketplace_name = "llmos-vault"
    description = (
        "llmOS Obsidian vault plugin and deterministic maintenance tooling "
        "for AI coding agents"
    )
    return (
        {
            "name": marketplace_name,
            "description": description,
            "owner": {"name": "kpeez", "email": "25070796+kpeez@users.noreply.github.com"},
            "plugins": [{"name": plugin_name, "source": PLUGIN_SOURCE}],
        },
        {
            "name": marketplace_name,
            "interface": {"displayName": marketplace_name},
            "plugins": [
                {
                    "name": plugin_name,
                    "source": {"source": "local", "path": PLUGIN_SOURCE},
                    "policy": DEFAULT_POLICY,
                    "category": DEFAULT_CATEGORY,
                }
            ],
        },
    )


def write(path: Path, catalog: dict) -> None:
    path.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"wrote {path.relative_to(REPO_ROOT)}")


def main() -> None:
    claude, agents = catalogs()
    write(CLAUDE_MARKETPLACE, claude)
    write(AGENTS_MARKETPLACE, agents)


if __name__ == "__main__":
    main()
