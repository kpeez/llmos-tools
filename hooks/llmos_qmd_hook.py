#!/usr/bin/env python3
"""Stop hook: reindex the qmd `llmos` collection iff this turn dirtied it.

Runs `qmd update -c llmos` only when the PostToolUse stamp hook
(`llmos_stamp_hook.py`) left a dirty flag for this session. The flag clears
only after a successful update. Failures remain retryable, emit a concise
diagnostic, and never block the turn. A vault-untouched turn spawns no qmd
process at all.
"""

from __future__ import annotations

import subprocess
import sys

from llmos_dirty_flag import flag_path
from llmos_hook import _read_payload

COLLECTION = "llmos"


def _warn(message: str) -> None:
    print(f"llmos qmd hook: {message}", file=sys.stderr)


def stop(data: dict) -> None:
    session_id = data.get("session_id") or "default"
    flag = flag_path(session_id, COLLECTION)
    if not flag.exists():
        return
    try:
        result = subprocess.run(["qmd", "update", "-c", COLLECTION], check=False)
    except OSError as exc:
        _warn(f"qmd update failed: {exc}; dirty flag retained for retry")
        return
    if result.returncode != 0:
        _warn(f"qmd update exited {result.returncode}; dirty flag retained for retry")
        return
    flag.unlink(missing_ok=True)


def main() -> None:
    try:
        stop(_read_payload())
    except Exception as exc:
        _warn(f"unexpected failure: {exc}")
        return  # hook failure must never block the turn


if __name__ == "__main__":
    main()
