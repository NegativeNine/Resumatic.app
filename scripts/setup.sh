#!/usr/bin/env bash
set -euo pipefail
# Defaults to a local plan. Applying provisioning always requires --apply.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/setup.mjs" "$@"
