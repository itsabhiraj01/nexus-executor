#!/usr/bin/env bash
# Run from a checked-out repository; all paths are resolved relative to this file.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$REPO_ROOT/scripts/install.mjs" "$@"
