# Nexus Executor — CLI, Headless Pairing Core & Installer

> **Status:** Design spec (approved). Terminal/pseudo-terminal and device-authorization flows are separate later slices and are intentionally out of scope here (noted only for context).

## Goal

Turn the executor from an `npm run pair`/`npm run start` project into a real `nexus-executor` command with subcommands, a single headless pairing core shared by every frontend, a single CLI state file the running service reads, and a `curl | bash` installer that provisions the machine and drives `nexus-executor pair`.

This is an **executor-only** slice. It does not change the nexus-gateway or nexus hub contracts.

## Architecture

- **`nexus-executor` CLI** — delivered via npm `bin`. No CLI framework; use `node:util` `parseArgs` (keeps the repo's deliberately lean dependency set).
- **Subcommands:** `pair`, `unpair`, `status`, `version`, `doctor`, `config`, `logs`, `update`. A bare `nexus-executor` prints a compact status summary. (The interactive full-screen TUI is a later slice; the bare command is deliberately a text summary for v1.)
- **Headless pairing core** — one `pair()` transport-agnostic function shared by the CLI, the installer, and (later) TUI/web. No frontend owns pairing logic.
- **Single CLI state file** — `~/.config/nexus-executor/state.json` indexes `{ transport, gatewayUrl | hubUrl, name, enrolledAt | pairedAt, identityPath }`. The real credential lives where it already does (gateway identity file for gateway; the DB `auth` config for direct). `status`/`unpair`/`doctor` read the one index regardless of transport.
- **Transport selection** — gateway is the **default**; pass `--hub` (or `HUB_URL`) to opt into direct. Supersedes the current hard `EXECUTOR_TRANSPORT` env gate for pairing.
- **Service reads CLI state at boot** — `main.ts` reads the state file for pairing/transport/URL instead of env `PAIR_CODE`. Env `PAIR_CODE` boot-pairing is **deprecated** (the containerized quickstart is updated to `nexus-executor pair`).

## Components / file layout

```
bin/nexus-executor              package.json "bin" → built CLI entry (thin, imports src/cli/cli.js)
src/cli/cli.ts                  subcommand dispatch + parseArgs + exit codes
src/cli/pair.ts                 interactive (prompts) + --gateway/--hub/--code/--name; gateway default
src/cli/status.ts               read state + credential stores → human or --json
src/cli/unpair.ts               delete credential + clear/mark state (two-step on a live machine)
src/cli/version.ts              print executor + protocol versions
src/cli/doctor.ts               gateway connectivity, opencode health, DB reachability, paired? ; --json
src/cli/config.ts               print/ask env config; write .env
src/cli/logs.ts                 tail the service journal or log file
src/cli/update.ts               best-effort pull + rebuild + restart (documented, non-destructive)
src/pairing/core.ts             headless pair() — transport-agnostic
src/pairing/state.ts            CLI state file read/write/mark
src/pairing/prompts.ts          minimal stdin prompt helper (stub-able for tests)
src/service/main.ts             boot: read CLI state instead of env PAIR_CODE
install.sh                      provisions, links `nexus-executor`, writes systemd unit, runs pair
```

Refactor existing `src/gateway.ts` `enrollGateway()` and `src/pairing.ts` `claimPairing()` to call `core.pair()` and write state — they become the transport implementations behind one core. `src/pairing.ts` is retired; `npm run pair` becomes `nexus-executor pair` (keep a thin compat script or drop it).

## Data flow — `nexus-executor pair` (gateway default)

1. Resolve gateway URL: `--gateway` > `GATEWAY_URL` env > prompt (default `https://gateway.example.com`).
2. Resolve pairing code: `--code` > `PAIR_CODE` env > prompt.
3. Call headless `pair()`:
   - gateway: generate Ed25519 keypair (reuse `gateway.ts`), POST `{code, public_key, hostname, executor_version, capabilities}` to `{gateway}/v1/enroll`, persist identity to `gateway-identity.json` (0600), write CLI state `{transport:'gateway', gatewayUrl, name, enrolledAt, identityPath}`.
   - direct (`--hub`): `claimPairing()` POSTs to the hub, stores the token hash in the DB, writes state `{transport:'direct', hubUrl, name, pairedAt}`.
4. On success, print the paired summary (`name`, transport, id/hub|gateway).

## State / error handling

- Already paired/enrolled → `pair` warns and no-ops (matches today's CLI); `status` reports it.
- Failure (bad code, gateway unreachable, malformed URL) → clear message + non-zero exit; state file is left clean (state written only after the credential succeeds).
- First-run `status` with no state file → `not paired — run nexus-executor pair`.
- `unpair` → delete credential + clear/mark state; `status` reflects it.
- `doctor` → gateway connectivity, opencode health, DB reachability, paired?:`; `--json` for automation.
- `logs`/`config`/`update` are thin, best-effort, documented. `logs` tail the service log: under systemd use `journalctl -u nexus-executor`, otherwise the executor's own log file (configurable; default to `data/executor.log`). `config` prints the effective runtime config (from CLI state + `.env`), not a pairing wizard — `.env` edits are left to the documented manual path. `update` is non-destructive (fetch, build, restart).

## Installer

`install.sh` (repo root): provision Node/npm (or use an existing runtime), build + link `nexus-executor` (`npm i -g`), write a systemd unit (`ExecStart` runs the built service), then invoke `nexus-executor pair` (interactive or with `--gateway/--code` flags / env). Unattended: `curl -fsSL https://executor.example.com/install | bash -s -- --gateway … --code …`. Installer does **not** own the pairing logic — it calls the CLI.

## Testing

- Unit tests for the headless `pair()` core and `state.ts`: transport resolution, already-paired no-op, failure → clean state, using existing vitest + testkit fixtures (DB, existing gateway enrollment tests).
- CLI subcommand tests: `parseArgs` dispatch, flag/env precedence, prompt fallback via a stubbed prompt fn, exit codes.
- `state.ts` round-trip (write/read/mark-unpaired).
- `install.sh`: shellcheck pass + `--dry-run` flag; not unit-tested like TS but linted/reviewed.
- README/quickstart updated to `nexus-executor pair/status` and the install flow.

## Out of scope (later slices)

- Interactive remote shell (pty) on the executor.
- Device-authorization pairing flow (executor shows a short code, user approves in Nexus) — needs new nexus-gateway + hub surfaces.
- Full-screen executor TUI.
- Local web UI (`nexus-executor web`).