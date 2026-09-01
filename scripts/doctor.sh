#!/usr/bin/env bash

# Compatibility entry point. The installed `llmos-doctor` command and the
# source-checkout path must exercise the same implementation.
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
export PYTHONPATH="$script_dir/..${PYTHONPATH:+:$PYTHONPATH}"
exec python3 -m llmos_vault.doctor "$@"
