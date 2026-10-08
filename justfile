# Task runner for the llmOS tools (run from tools/).

_default:
    @just --list

gen:
    uv run python scripts/gen-marketplaces.py

drift: gen
    git diff --exit-code ../.claude-plugin/marketplace.json ../.agents/plugins/marketplace.json

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

# TypeScript core (Bun); `bun install --frozen-lockfile` first.
ts-types:
    bun run typecheck

ts-lint:
    bun run lint

ts-test:
    bun test

# Compare the TypeScript core with the Python CLI on the fixture vaults and
# a generated edge-case vault. For the real vault, copy it outside llmOS/
# first and pass the copy: bun test/differential/run.ts --report FILE COPY
differential:
    bun run differential

# Compare the TypeScript activity digest with the Python one on a generated
# vault: same block hash, markers, and note text for the same gh output. For
# recorded real gh output, see the usage at the top of that file.
differential-digest:
    bun test/differential/digest.ts --edge

check: drift lint types test ts-types ts-lint ts-test differential differential-digest
