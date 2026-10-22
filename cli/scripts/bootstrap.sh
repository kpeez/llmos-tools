#!/usr/bin/env bash
# Set up llmOS on this host from a checkout, in one command:
#
#   <checkout>/tools/cli/scripts/bootstrap.sh
#
# 1. Installs the llmOS CLI (cli/scripts/install.ts).
# 2. Points the CLI at <checkout>/llmOS, unless a root is already configured.
# 3. Installs the llmos plugin for each agent on PATH (claude, codex). It adds
#    this checkout as the llmos-vault marketplace only when no marketplace of
#    that name is registered, and installs the plugin only when it is missing.
# 4. Runs llmos-doctor and exits with its status.
#
# Safe to run again. The steps that need a person are printed at the end; the
# setup-llmos skill covers repair and verification.

set -euo pipefail

tools="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
checkout="$(dirname "$tools")"
vault="$checkout/llmOS"
bin="$HOME/.local/bin"
config="$HOME/.config/llmos/config.json"
plugin="llmos@llmos-vault"

step() { printf '\n== %s\n' "$1"; }

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not on PATH. Install it, open a new shell, and run this again:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# Exit 0 when the JSON on stdin passes the check, a JavaScript expression of
# `data`.
json_has() {
  bun -e 'const data = JSON.parse(await Bun.stdin.text()); process.exit(eval(process.argv.at(-1)) ? 0 : 1);' \
    "$1" 2>/dev/null
}

step "Install the llmOS CLI"
bun "$tools/cli/scripts/install.ts"

step "Set the vault root"
if [ -n "${LLMOS_ROOT:-}" ]; then
  echo "LLMOS_ROOT is set ($LLMOS_ROOT) and wins over the config file; no change."
elif [ -f "$config" ]; then
  echo "$config already exists; no change:"
  cat "$config"
else
  "$bin/llmos-vault" config set-root "$vault"
fi

if command -v claude >/dev/null 2>&1; then
  step "Install the plugin for Claude Code"
  if claude plugin marketplace list --json | json_has 'data.some((m) => m.name === "llmos-vault")'; then
    echo "marketplace llmos-vault is already registered; no change."
  else
    claude plugin marketplace add "$checkout"
  fi
  if claude plugin list --json | json_has "data.some((p) => p.id === \"$plugin\")"; then
    echo "$plugin is already installed; no change."
  else
    claude plugin install "$plugin"
  fi
fi

if command -v codex >/dev/null 2>&1; then
  step "Install the plugin for Codex"
  if codex plugin marketplace list --json | json_has 'data.marketplaces.some((m) => m.name === "llmos-vault")'; then
    echo "marketplace llmos-vault is already registered; no change."
  else
    codex plugin marketplace add "$checkout"
  fi
  if codex plugin list --marketplace llmos-vault --json |
    json_has "data.installed.some((p) => p.pluginId === \"$plugin\")"; then
    echo "$plugin is already installed; no change."
  else
    codex plugin add "$plugin"
  fi
fi

step "Run the doctor"
status=0
"$bin/llmos-doctor" || status=$?

step "Do these steps by hand"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "- Add $bin to PATH." ;;
esac
cat <<EOF
- Open the $vault folder in Obsidian as the vault 'llmOS', and turn on its
  command line interface (Settings > General > Advanced).
- Codex: open Codex once and approve the llmOS hook.
- Start one new session for each agent, end it, and run llmos-doctor again.
- Fix each FAIL with its REPAIR line, or use the setup-llmos skill.
EOF
exit "$status"
