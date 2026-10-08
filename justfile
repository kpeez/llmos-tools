# Task runner for the llmOS tools (run from tools/; `bun install --frozen-lockfile` first).

_default:
    @just --list

# Regenerate the marketplace catalogs at the repository root.
gen:
    bun scripts/gen-marketplaces.ts

# Fail when a catalog differs from a fresh generation.
drift: gen
    git diff --exit-code ../.claude-plugin/marketplace.json ../.agents/plugins/marketplace.json

types:
    bun run typecheck

lint:
    bun run lint

# Unit tests, hook tests, and the contract snapshot tests (test/contract/).
test:
    bun test

# Record the contract snapshots again from the TypeScript output, after an
# intended contract change; review the diff before committing it.
contract-record:
    bun test/contract/record.ts

# Check the frontmatter invariants on a vault. For the real vault, copy it
# outside llmOS/ first and pass the copy; write any report to ../artifacts/.
invariants +vaults:
    bun test/contract/invariants.ts {{vaults}}

# Rebuild the committed plugin bundles: the hooks (dist/hooks.js, from
# src/hooks/) and the MCP launcher (dist/mcp.js, from src/mcp-launcher.ts).
hooks:
    bun run build:hooks
    bun run build:mcp

# Fail when a committed bundle differs from a fresh build.
hooks-drift: hooks
    git diff --exit-code dist/hooks.js dist/mcp.js

check: drift types lint test hooks-drift
