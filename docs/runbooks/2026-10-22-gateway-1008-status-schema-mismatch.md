# Runbook — Gateway session closes 1008 right after answering (`status.get` schema mismatch)

**Date:** 2026-10-22
**Status:** Root cause proven executor-side (controlled experiment, §3). Fix is a
**gateway deploy** — the executor's pairing and code are fine.
**Executor:** `97afab48-5204-4344-8fa4-e0a02b87eb23` (`office-agent`, this host,
transport `gateway`)

## TL;DR

After the 2026-10-22 executor update (`ff51340` → `145b648`, "unified lineage" +
pipelines/harness), every gateway session **opens fine and closes with code 1008
within ~0.4–1.3 s**, forever (`gateway session lost; reconnecting`,
`sessionDurationMs ≈ 390–1310`, empty close reason).

This is **not** a pairing or auth problem: the silent probe holds, garbage
credentials are cleanly 401ed, and `nexus-executor repair`'s static checks all
pass. What fails is the **first response the executor sends**: the hub flushes
its queued `status.get` polls at every session open, and `nexus-gateway`'s
protocol adapter grades that response against an **exact field whitelist**
(`nexus-gateway src/protocol/nexus.ts`). This build's `status.get` payload grew
the `upgrade:` field (self-upgrade state machine, `src/ops.ts` `opStatus`) —
the deployed gateway's whitelist does not know it and punishes the session with
1008 (policy violation).

The three protocol mirrors MUST stay identical — `src/ops.ts` (executor),
`modules/builder/src/gateway-protocol.ts` and `nexus-gateway src/protocol/nexus.ts`
(hub monorepo). Only the executor side moved; **deploy the matching
`nexus-gateway` build and restart it**.

## 1. Signature

| Observation | Value |
|---|---|
| Upgrade `wss://…/v1/connect` | succeeds (auth proof accepted) |
| First traffic after open | a burst of queued `status.get` requests (~10–18, ~250 ms in) |
| Close | `1008`, empty reason, **0.4–1.3 s after the first answer** |
| Silent session (never answers) | **holds indefinitely** |
| Garbage credential | upgrade rejected HTTP 401 (auth layer healthy) |

The silent-vs-answered split is the whole diagnosis: the gateway grades what the
executor **answers**, not the connection itself.

## 2. Timeline (2026-10-22, IST)

| Time | Event |
|---|---|
| 17:07:53 | `git pull` fast-forwards `ff51340` → `145b648` |
| 17:08:48 | `tsc` build finishes (new modules: `upgrade.js`, `model-policy.js`, `terminal-store.js`) |
| 17:08:48 | previous service (pid 3234, pre-update build) SIGTERMed — it had held sessions for up to **70 min** |
| 17:08:55 | new service (pid 49337) starts the fresh build |
| 17:08:59 | first `closeCode: 1008` — and every attempt since |
| ~17:30 | `nexus-executor repair` still reports `healthy` — its silent probe cannot see the failure (this runbook's lesson) |

## 3. Controlled experiment (executor-side proof)

Same host, same identity file, same `buildConnectHeaders()` proof, service
stopped to remove session-lease interference. Only the **answer** varied:

| Probe behavior | Result |
|---|---|
| Never answers (silent socket) | held ≥ 8 s |
| Answers `status.get` with this build's real payload (via `handleGatewayOperation`) | **1008 in < 700 ms** |
| Same payload with `upgrade:` removed (full new `capabilities` bag kept) | held ≥ 8 s |
| Pre-update (`ff51340`) payload shape | held ≥ 8 s |
| Empty/invalid response envelope | 1008 (as expected — codec rejection) |

Conclusion: the `upgrade:` field (top-level on the `status.get` result) is what
the deployed whitelist rejects. The expanded `capabilities` bag is fine
(free-form). An invalid envelope closes the same way, which is why the probe
must answer through the **real** dispatcher — the shipped answered probe in
`nexus-executor repair` does exactly that.

## 4. Decision table (`nexus-executor repair`)

| Valid (silent) probe | Garbage probe | Answered probe | Verdict |
|---|---|---|---|
| holds | 401 / 1008 | holds | `healthy` |
| holds | 401 / 1008 | **1008 after answering** | `gateway-schema-mismatch` ← this runbook |
| 1011 fast close | rejected cleanly | — | `hub-session-open-failure` (see `2026-10-13-gateway-1011-hub-failure.md`) |
| rejected (1008 / 401) | — | — | `identity-rejected` (see `2026-10-08-gateway-executor-auth-failure.md`) |

Note the 1008 code is overloaded: `authentication_failed` **at the auth stage**
(identity problem) vs a policy close **after answering** (schema problem). The
stage — not the code — is the discriminator.

## 5. Fix

Executor-side: nothing to fix (latest code, paired, migrations fine).

Server-side (the actual fix):

1. Deploy the hub monorepo build whose `nexus-gateway src/protocol/nexus.ts`
   whitelist includes the `status.get` `upgrade` field (mirror of `src/ops.ts`
   `opStatus`).
2. `sudo systemctl restart nexus-gateway`
3. `journalctl -u nexus-gateway -n 50 --no-pager` — clean boot.

Stopgap (only if the gateway deploy must wait): run the pre-update executor
build (`ff51340`-era) — its `status.get` payload passes the old whitelist. It
costs the pipeline/harness/self-upgrade features of `145b648`.

## 6. Verification

```bash
nexus-executor repair          # verdict must become `healthy`, "connect answered" PASS
journalctl --user -u nexus-executor -n 50
# expect long-lived sessions: "gateway WebSocket opened" WITHOUT a following
# "gateway session lost" (sessionDurationMs in the minutes, not ~500)
```

The executor's reconnect loop never gives up — it starts passing traffic the
moment the gateway is updated, no executor restart required.
