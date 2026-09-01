#!/usr/bin/env python3
"""Back-compat shim over `llmos_vault.root`.

The hook (`hooks/llmos_hook.py`) and the setup-llmos skill still import this
module by file path via `sys.path`/`importlib`, so it stays in place rather
than moving wholesale. The canonical implementation -- and the only place the
resolution logic itself lives -- is `llmos_vault.root`; `CONFIG_PATH` here is
re-read on every call so tests that monkeypatch this module's `CONFIG_PATH`
still change behavior.
"""

from __future__ import annotations

import sys
from pathlib import Path

# This shim is also invoked directly by plugin hooks and skill helpers with a
# system Python that does not have the package installed.  Add the checkout's
# package root before importing the canonical implementation.  Normal imports
# provide the module origin through ``__spec__``; direct script execution and
# embedders that omit a module spec use the executable path as a fallback.
_module_spec = globals().get("__spec__")
_module_origin = getattr(_module_spec, "origin", None) or sys.argv[0]
_plugin_root = Path(_module_origin).resolve().parents[1]
if str(_plugin_root) not in sys.path:
    sys.path.insert(0, str(_plugin_root))

from llmos_vault.root import DEFAULT_CONFIG_PATH, validated  # noqa: E402
from llmos_vault.root import vault_root as _vault_root  # noqa: E402

CONFIG_PATH = DEFAULT_CONFIG_PATH
__all__ = ["CONFIG_PATH", "validated", "vault_root"]


def vault_root() -> Path:
    """Resolve the llmOS vault root: $LLMOS_ROOT -> config file -> fail loud."""
    return _vault_root(config_path=CONFIG_PATH)


if __name__ == "__main__":
    print(vault_root())
