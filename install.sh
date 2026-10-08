#!/usr/bin/env bash
# Nexus Executor installer.
#
#   curl -fsSL https://executor.example.com/install | bash
#   curl -fsSL https://executor.example.com/install | bash -s -- --gateway https://gateway.example.com --code ABC123
#
# Provisions, builds, links the `nexus-executor` binary, writes a systemd
# user unit, then invokes `nexus-executor pair`. The installer NEVER owns the
# pairing logic — it delegates to the CLI, so upgrading the pairing protocol
# does not require maintaining duplicate shell logic here.
set -euo pipefail

GATEWAY=""
CODE=""
DRY_RUN=0

usage() {
  echo "Usage: install.sh [--gateway URL] [--code CODE] [--dry-run]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway) GATEWAY="${2:-}"; shift 2 ;;
    --code)    CODE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) usage ;;
  esac
done

step() { echo; echo "→ $*"; }
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then echo "   (dry-run) $*"; else "$@"; fi
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run mode — no changes will be made."
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step "Building & installing nexus-executor"
run npx --yes ci
run npm run build
run npm link

step "Writing systemd unit (nexus-executor.service)"
UNIT_DIR="${HOME}/.config/systemd/user"
run mkdir -p "$UNIT_DIR"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "   (dry-run) write \$UNIT_DIR/nexus-executor.service"
else
  cat > "$UNIT_DIR/nexus-executor.service" <<UNIT
[Unit]
Description=Nexus Executor
After=network-online.target

[Service]
ExecStart=/usr/bin/env node "${REPO_ROOT}/dist/main.js"
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNIT
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  step "Done (dry-run)."
  exit 0
fi

systemctl --user daemon-reload
systemctl --user enable --now nexus-executor

step "Pairing this machine"
PAIR_CMD=(nexus-executor pair)
[[ -n "$GATEWAY" ]] && PAIR_CMD+=(--gateway "$GATEWAY")
[[ -n "$CODE" ]] && PAIR_CMD+=(--code "$CODE")
"${PAIR_CMD[@]}"

echo
echo "Installed. Status:"
nexus-executor status