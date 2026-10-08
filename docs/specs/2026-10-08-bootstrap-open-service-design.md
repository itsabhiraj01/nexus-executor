# Nexus Executor — Bootstrap: OpenCode Server + systemd/launchctl Service

> **Status:** Design spec (approved). Source of implementation: a new `bootstrap.sh`.

## Goal

Automate, end-to-end, standing up a **new executor machine**:

1. Install/config/run the **OpenCode `serve` server** the executor depends on.
2. Build and run the **executor** as a managed background service.
3. Run both as **systemd** (Linux) or **launchd** (macOS) user-scoped services.

The script must be fully **idempotent and resumable**: on any re-run it checks live state
before each step, skips anything already set up, and converges a partially-provisioned
machine. It must handle **missing tools** and **missing access** gracefully.

## Non-goals / deferred

- The full-screen executor TUI, local web UI, and device-authorization pairing flows
  (separate later slices).
- Rewriting the existing `install.sh`; `bootstrap.sh` is a new, orchestrating script. It
  may reuse the pairing/CLI already built (`nexus-executor pair`).

## Architecture

One self-contained `bootstrap.sh` at the executor repo root, organized as an **ordered
manifest of steps**. Each step is a **probe → act → re-probe** function:

- **Probe** gently checks whether the step is already done (live state, no persisted ledger).
  If done → print `SKIP (already done)` and move to the next step.
- **Act** performs the change only when the probe says it is not yet done.
- **Re-probe** confirms the step converged; `OK` on success, `FAIL` otherwise.

**'Done' for a service step** = the service unit/plist is installed, enabled, running, and
(for OpenCode) the port is listening.

**No persistent state ledger**: each run re-derives state purely from live probes (the
user-selected model). This means the script is always safe to re-run and cannot record a
stale "done" for something that later broke.

## Manifest (in order)

Each step skips (live probe) when already done.

1. **detect-platform** → resolve service manager: `systemd` (Linux + `systemctl --user`),
   `launchd` (macOS + `launchctl`), or `degrade` (neither present). Print the target.
2. **opencode-install** → if `opencode` is not on `PATH`, install via the documented
   OpenCode `curl | bash` installer into `~/.opencode/bin`.
3. **opencode-config** → ensure an OpenCode server password is set (`OPENCODE_SERVER_PASSWORD`).
   Prompt only when not already present (see Secrets).
4. **opencode-service** → write a user systemd unit (or launchd plist) that runs
   `opencode serve` on the pinned port/host; `enable` + `start`; confirm listening.
5. **executor-build** → `npm ci` + `npm run build`; skip if `dist/main.js` is newer than
   every `src/**/*.ts` and `package.json` (i.e., the build is already current) — checked by
   comparing newest source mtime vs `dist/main.js` mtime.
6. **executor-link** → ensure the `nexus-executor` binary is on `PATH`
   (`npm link` or a `~/.local/bin` symlink to `dist/cli/cli.js`).
7. **executor-service** → write a user systemd unit (or plist) running
   `dist/main.js`; `enable` + `start`; confirm running.
8. **pair** *(optional; only when `--pair` is passed)* → prompt for gateway URL + pairing
   code, then delegate to `nexus-executor pair`. Skipped otherwise.
9. **verify/summary** → print a per-step `done / skipped-already / failed` table.
   Exit 0 if everything converged; non-zero if any step failed.

## Failure & resume behavior

**Fail-fast:** stop at the first not-done step that fails to become done. Print exactly
which step failed, why, and the exact re-run command. Exit non-zero.

**Resume:** because every step is a live probe, re-running the script skips everything
already done and only retries from the failed step onward. That is the resume story — no
ledger required, and a step that only *looked* done but is now broken gets re-probed.

**Missing access / missing tools:** handled embarrassingly per step:

- No `systemd` and no `launchctl` → the service steps degrade to a **background-manager
  fallback** (`nohup … &` + PID file in `~/.local/state/nexus-executor/`), with a clear
  warning that process supervision is reduced.
- `opencode` binary missing → step 2 installs it (probe first, so re-run skips).
- `npm`/`node` missing or unbuildable → clear "missing tool" message, fail-fast (cannot
  degrade past a missing runtime) with the re-run hint.
- No `systemctl --user` permission (e.g. user services unsupported) → same fallback.

## Secrets

Prompted **by value-presence**:

- If `OPENCODE_TOKEN`/`OPENCODE_SERVER_PASSWORD` is already set (in `.env` or the service
  env), **keep it** and do not prompt (this preserves unattended resume).
- If not set, prompt once for the OpenCode server password.
- The OpenCode service gets the pinned password (`OPENCODE_SERVER_PASSWORD`).
- `OPENCODE_TOKEN` is synced into the executor's `.env` only if absent.
- Executor pairing secrets are handled by the `--pair` step via `nexus-executor pair`.

## Cross-platform service layout

| Manager | User-scope location | Control |
| --- | --- | --- |
| **systemd** (Linux) | `~/.config/systemd/user/opencode.service`, `…/nexus-executor.service` | `systemctl --user {enable,start,is-active,is-enabled}` |
| **launchd** (macOS) | `~/Library/LaunchAgents/dev.nexus.opencode.plist`, `…/nexus-executor.plist` | `launchctl {load,bootstrap,list,kickstart}` |
| **degrade** (neither) | `~/.local/state/nexus-executor/` PID files | `nohup … &` |

OpenCode and the executor remain **two separate services** so their lifecycles are
independent and a partial setup converges incrementally.

## Interface

```
bootstrap.sh [opts]
  --dry-run          print each step's would-do, act on nothing, exit 0
  --start            start services that are installed but stopped
  --opencode-only    run only the opencode steps (2-4)
  --executor-only    run only the executor steps (5-7)
  --pair             run the optional pairing step (8) and final summary
  --yes              non-interactive defaults (no prompts; skip secret prompts if possible)
  --help             show usage
```

Defaults: run the whole manifest except pairing.

## Testing

- `bash -n bootstrap.sh` — syntax check.
- `shellcheck bootstrap.sh` — lint (if available).
- `--dry-run` — exercises the full manifest's probe + would-do without acting; must be
  safe to run and leave no changes.
- Mock/partial harness (a `test/bootstrap.sh` script): runs `bootstrap.sh` against a
  temporary `HOME` where (a) `opencode` is absent, (b) no service manager is detected,
  (c) services are partially installed. Asserts:
  - missing tools degrade (or fail with the right message),
  - a partially-provisioned machine converges,
  - a re-run after a successful run reports everything `SKIP (already done)`.