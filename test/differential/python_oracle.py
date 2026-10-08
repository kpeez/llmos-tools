"""Python side of the differential harness: run the frozen `llmos_vault`
CLI on one vault and write every compared result as JSON.

Run from `tools/` (the harness does this):
    uv run python test/differential/python_oracle.py VAULT --today 2026-10-07 \
        --output FILE [--subgraph-depth2 NOTE ...]

The `read`, `list`, `neighbors`, `subgraph`, `check`, `health --json`, and
`daily recent` results are what the `llmos-vault` CLI prints and its exit
code, from its cyclopts app called in-process with `LLMOS_ROOT` set to VAULT:
`{"exit": code, "json": printed}`, or `{"exit": 1, "error": message}` for a
command that fails with a message (`health` puts its exit code beside the
report's fields). `normalize` is `llmos_vault.frontmatter.normalize` and the
schema audit is `llmos_vault.schema.collect_errors` (what `llmos-audit`
prints), because the CLI has no JSON form of either; a refusal there becomes
`{"error": kind, "message": text}`.

The package re-reads every file and rebuilds the index on each call, which
makes a whole-vault run take hours. This script memoizes `build_index` and
`read_frontmatter` per argument. Both are pure while the vault is unchanged,
so every result is the one the CLI prints. `health` and `daily` read
`--today` instead of the clock, and qmd reads as unavailable, so the qmd
section is the notice on both sides (`test/qmd.test.ts` covers real gaps).
"""

from __future__ import annotations

import argparse
import contextlib
import functools
import io
import json
import os
from datetime import date
from pathlib import Path

from llmos_vault import authoring, cli, daily, graph, health, links, notes
from llmos_vault.frontmatter import MissingFrontmatter, UnsupportedFrontmatter, normalize
from llmos_vault.schema import collect_errors


def _install_memoization() -> None:
    cached_index = functools.lru_cache(maxsize=None)(links.build_index)
    cached_read = functools.lru_cache(maxsize=None)(links.read_frontmatter)
    for module in (links, graph, health, authoring, notes, cli):
        if hasattr(module, "build_index"):
            setattr(module, "build_index", cached_index)
        if hasattr(module, "read_frontmatter"):
            setattr(module, "read_frontmatter", cached_read)


def _fix_today(today: date) -> None:
    class FixedDate(date):
        @classmethod
        def today(cls) -> date:  # type: ignore[override]
            return today

    setattr(health, "date", FixedDate)
    setattr(daily, "date", FixedDate)
    setattr(health, "_qmd_indexed_paths", lambda collection: None)


def _error(exc: BaseException) -> dict[str, str]:
    if isinstance(exc, SystemExit):
        message = str(exc.code)
        kind = "ambiguous" if " is ambiguous, matches: " in message else "not-found"
    else:
        message = str(exc)
        kind = type(exc).__name__
    return {"error": kind, "message": message}


def _cli(*tokens: str) -> dict[str, object]:
    """The JSON one CLI command prints and its exit code, or its error message."""
    out = io.StringIO()
    code = 0
    try:
        with contextlib.redirect_stdout(out):
            cli.app(list(tokens))
    except SystemExit as exc:
        # `check` and `health` exit 1 on findings after printing their JSON;
        # a message exit prints the message and exits 1.
        if not (exc.code is None or isinstance(exc.code, int)):
            return {"exit": 1, "error": str(exc.code)}
        code = exc.code or 0
    except (UnsupportedFrontmatter, ValueError) as exc:
        return {"exit": 1, "error": str(exc)}
    return {"exit": code, "json": json.loads(out.getvalue())}


def _normalize(path: Path) -> object:
    try:
        return normalize(path.read_text())
    except (MissingFrontmatter, UnsupportedFrontmatter) as exc:
        return _error(exc)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("vault", type=Path)
    parser.add_argument("--today", required=True)
    parser.add_argument("--subgraph-depth2", nargs="*", default=[])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root: Path = args.vault
    os.environ["LLMOS_ROOT"] = str(root)
    _install_memoization()
    _fix_today(date.fromisoformat(args.today))

    index = links.build_index(root)
    relatives = [str(path.relative_to(root)) for path in index.paths]
    names = sorted({path.stem for path in index.paths})
    depth2 = set(args.subgraph_depth2)

    per_note: dict[str, dict[str, object]] = {}
    for relative in relatives:
        result: dict[str, object] = {
            "read": _cli("read", relative),
            "neighbors": _cli("neighbors", relative),
            "subgraph1": _cli("subgraph", relative, "--depth", "1"),
            "check": _cli("check", relative),
            "normalize": _normalize(root / relative),
        }
        if relative in depth2:
            result["subgraph2"] = _cli("subgraph", relative, "--depth", "2")
        per_note[relative] = result

    health_run = _cli("health", "--json")
    report = health_run["json"]
    assert isinstance(report, dict), health_run
    errors, checked = collect_errors(root)
    results = {
        "list": _cli("list")["json"],
        "daily_recent": _cli("daily", "recent", "--n", "2"),
        "notes": per_note,
        "by_name": {name: _cli("read", name) for name in names},
        "health": {**report, "exit": health_run["exit"]},
        "schema": {"errors": errors, "checked": checked},
    }
    with args.output.open("w", encoding="utf-8") as handle:
        json.dump(results, handle)


if __name__ == "__main__":
    main()
