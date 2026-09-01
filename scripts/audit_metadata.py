#!/usr/bin/env python3
"""Compatibility entry point for the installed ``llmos-audit`` command."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from llmos_vault.audit import *  # noqa: F401,F403
from llmos_vault.audit import main

if __name__ == "__main__":
    main()
