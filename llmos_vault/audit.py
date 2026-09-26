"""Audit llmOS frontmatter contracts. Read-only."""

from __future__ import annotations

import argparse
from pathlib import Path

from llmos_vault.root import vault_root
from llmos_vault.schema import collect_errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Vault root; resolved via the shared resolver when omitted.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = args.root.expanduser().resolve() if args.root else vault_root()
    errors, checked = collect_errors(root)
    if errors:
        print("\n".join(errors))
        raise SystemExit(1)
    print(f"metadata audit passed: {checked} notes")


if __name__ == "__main__":
    main()
