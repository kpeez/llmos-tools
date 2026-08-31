# Task runner for llmos-vault.

_default:
    @just --list

gen:
    uv run python scripts/gen-marketplaces.py

drift: gen
    git diff --exit-code .claude-plugin/marketplace.json .agents/plugins/marketplace.json

lint:
    uv run ruff check

fmt:
    uv run ruff format

types:
    uv run ty check

test:
    uv run pytest

build:
    uv build

check: drift lint types test
