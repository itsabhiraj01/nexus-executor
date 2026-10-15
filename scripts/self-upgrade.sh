#!/usr/bin/env bash
# scripts/self-upgrade.sh — the shipped in-place upgrade job the hub
# can trigger through POST /api/v1/upgrade (docs/remote-executors.md
# §Upgrading an executor from the hub).
#
# What it does, in order:
#   1. fast-forward EXECUTOR_REPO_DIR (a git checkout DEDICATED to this
#      executor — never a Builder job workspace, never the hub's live main
#      checkout: the reset below is destructive to local edits);
#   2. rebuild the executor (the hub tree's toolchain when this checkout is
#      a nexus monorepo, the executor's own when it's an executor-only
#      checkout (nexus-executor.git), an npm install as the cold-start
#      fallback — slow and toolchain-dependent);
#   3. optionally rsync the executor tree into EXECUTOR_INSTALL_DIR when the
#      service runs from somewhere else (persistent state — .env, data/ — survives);
#   4. flip the upgrade state file to "restarting" (the freshly booted
#      executor finalizes it to "done" — systemd's control-group kill would
#      otherwise take this script down with the old service before it could
#      record anything);
#   5. daemon-reload + restart the systemd USER service.
#
# The upgrader (src/upgrade.ts) copies this script out of the repo
# before running it — the reset must never change the bytes of the running
# interpreter — and hands EXECUTOR_UPGRADE_STATE_FILE / _REF / _SERVICE_NAME
# / _INSTALL_DIR through the environment.
set -euo pipefail

REPO_DIR="${EXECUTOR_REPO_DIR:-}"
REF="${EXECUTOR_UPGRADE_REF:-main}"
SERVICE="${EXECUTOR_SERVICE_NAME:-nexus-executor}"
STATE_FILE="${EXECUTOR_UPGRADE_STATE_FILE:-}"
INSTALL_DIR="${EXECUTOR_INSTALL_DIR:-}"

log() { printf 'self-upgrade: %s\n' "$*"; }
die() { printf 'self-upgrade: ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$REPO_DIR" ] || die "EXECUTOR_REPO_DIR is unset — point it at this machine's own executor checkout"
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 \
  || die "$REPO_DIR is not a git checkout — the upgrade needs a dedicated clone (docs/remote-executors.md)"

# The checkout's executor directory: a full nexus monorepo checkout carries
# it in executor/, an executor-only checkout (nexus-executor.git) IS it.
if [ -f "$REPO_DIR/executor/package.json" ]; then
  SRC_DIR="$REPO_DIR/executor"
elif [ -f "$REPO_DIR/package.json" ]; then
  SRC_DIR="$REPO_DIR"
else
  die "$REPO_DIR carries neither executor/package.json nor package.json — not an executor checkout?"
fi

# --- 1. fast-forward --------------------------------------------------------
log "fetching origin and resetting onto origin/$REF (local edits in $REPO_DIR are discarded)"
git -C "$REPO_DIR" fetch origin "$REF"
git -C "$REPO_DIR" reset --hard "origin/$REF"
[ -f "$SRC_DIR/package.json" ] || die "$SRC_DIR/package.json missing after the reset — not an executor checkout?"
NEW_VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$SRC_DIR/package.json" | head -1)"
log "checkout now carries executor v${NEW_VERSION:-unknown}"

# --- 2. rebuild -------------------------------------------------------------
if [ -x "$REPO_DIR/node_modules/.bin/tsc" ] && [ "$SRC_DIR" != "$REPO_DIR" ]; then
  # Hub-tree topology: the executor's deps ride the monorepo's node_modules.
  log "building the executor with the checkout's toolchain"
  (cd "$SRC_DIR" && "$REPO_DIR/node_modules/.bin/tsc")
elif [ -x "$SRC_DIR/node_modules/.bin/tsc" ]; then
  # Executor-only checkout (or monorepo executor/ with its own install).
  log "building the executor with its own toolchain"
  (cd "$SRC_DIR" && ./node_modules/.bin/tsc)
else
  # Cold start: a checkout that never installed. Slow and needs a
  # C++ toolchain for node-pty — the failure (if any) lands in this log and
  # the old service keeps running.
  log "no toolchain in the checkout — installing the executor's deps (node-pty needs a C++ toolchain)"
  (cd "$SRC_DIR" && npm install && npm run build)
fi
[ -f "$SRC_DIR/dist/main.js" ] || die "$SRC_DIR/dist/main.js missing after the build"

# --- 3. optional rsync into the install dir ---------------------------------
if [ -n "$INSTALL_DIR" ] && [ "$(realpath -m "$INSTALL_DIR")" != "$(realpath -m "$SRC_DIR")" ]; then
  log "syncing $SRC_DIR into $INSTALL_DIR (persistent state survives: .env, data/)"
  command -v rsync >/dev/null || die "rsync is required when EXECUTOR_INSTALL_DIR is set"
  mkdir -p "$INSTALL_DIR"
  rsync -a --delete \
    --exclude='/.env' \
    --exclude='/data' \
    --exclude='/node_modules' \
    "$SRC_DIR/" "$INSTALL_DIR/"
  # node-pty is NATIVE and exists only where it was compiled — carry the
  # built copy over like scripts/deploy-executor.sh does, else the service
  # loses terminal support on a box that could build it in the checkout.
  if [ -d "$SRC_DIR/node_modules/node-pty" ]; then
    mkdir -p "$INSTALL_DIR/node_modules"
    rsync -a --delete "$SRC_DIR/node_modules/node-pty" "$INSTALL_DIR/node_modules/"
    rsync -a --delete "$SRC_DIR/node_modules/node-addon-api" "$INSTALL_DIR/node_modules/"
  fi
fi

# --- 4. hand off the restart to the next boot -------------------------------
if [ -n "$STATE_FILE" ]; then
  STATE_FILE="$STATE_FILE" node --input-type=module -e '
    import { readFileSync, writeFileSync, renameSync } from "node:fs";
    const path = process.env.STATE_FILE;
    let state = {};
    try { state = JSON.parse(readFileSync(path, "utf8")); } catch { /* a fresh file is fine */ }
    state.phase = "restarting";
    state.updatedAt = new Date().toISOString();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
  '
fi

# --- 5. restart -------------------------------------------------------------
log "restarting $SERVICE — the machine blips Unreachable for one hub ping cycle"
systemctl --user daemon-reload
systemctl --user restart "$SERVICE"
log "restart issued — the booted executor finalizes the upgrade state"
