# Runbook — Gateway session closes with 1011 (`hub_failure`) — diagnosis in progress

**Date:** 2026-10-13
**Status:** Executor side ruled out; `make repair` (§2.1) confirmed **auth passes, session-open fails** — awaiting server-side evidence for the *why* (commands in §4)
**Executor:** `97afab48-5204-4344-8fa4-e0a02b87eb23` (`office-agent`, this host, transport `gateway`)

## TL;DR

The executor's outbound WebSocket to
`wss://nexus-executor.abhirajtomar.com/v1/connect` **upgrades successfully, then
is closed by the server with code 1011 ~300 ms later**, on a reconnect loop
(~10–30 s backoff, `sessionDurationMs ≈ 300–330`, empty close reason). Same
signature as the 2026-10-10 investigation.

`hub_failure` (the gateway's journal event for this executor) means the
gateway's call into the hub's private transport listener
(`127.0.0.1:3201/transport`) **errored** — a 500-class failure or a response the
gateway codec rejects — as opposed to a clean 401 denial. A denial would log
`authentication_failed` (that is the *other*, already-documented executor — see
`2026-10-08-gateway-executor-auth-failure.md`). **The root cause is on the
server** (hub transport / DB / gateway↔hub path), not on this host.

**Confirmed remotely 2026-10-13 01:50** by `make repair`'s differential probe
(§2.1): a garbage credential is cleanly rejected (HTTP 401 at the upgrade)
while our valid proof is accepted — the hub is up, its auth path works, and
what errors is specifically the **post-auth session-open** call (hypothesis 1).

## 1. Timeline (2026-10-12, IST)

| Time | Event |
|---|---|
| 22:52:32 | Fresh native install: `nexus-db` + `opencode-executor` + `nexus-executor` all enabled and running; executor reuses existing identity (enrolled 2026-10-09 02:20) |
| 22:52:34 | First gateway dial answered **HTTP 502** (origin down); attempts 1–11 all 502 |
| ~23:05 | Transition: WS upgrades start succeeding, but every session closes **1011** ~300 ms in |
| 23:05 → | Steady state: `gateway WebSocket opened; awaiting gateway requests` → close 1011 → backoff → repeat. Executor otherwise healthy |
| Oct 13 01:12 | Service restarted (reinstall; identity untouched, `make pair` idempotent — §3.1). 1011 loop persists with identical signatures (`sessionDurationMs ≈ 306–326`) |
| Oct 13 01:50 | `make repair` differential probe (§2.1): invalid credential → HTTP 401 at the upgrade; valid proof → upgrade OK, close 1011 in 327 ms. Verdict `hub-session-open-failure` |

No known server-side change at ~23:05 (user-confirmed). What restarted or
recovered then is itself evidence — see command 2.

## 2. Ruled out on the executor host

| Check | Result |
|---|---|
| Identity `data/gateway-identity.json` | Present, mode 0600, enrolled 2026-10-09 (`executorId 97afab48-…`) |
| Clock (proof window is ±120 s, `PROOF_SKEW_MS`) | NTP-synchronized |
| Config (`~/.config/nexus-executor/executor.env`, `.env`) | `EXECUTOR_TRANSPORT="gateway"`, `GATEWAY_URL=https://nexus-executor.abhirajtomar.com` — correct |
| Local units | `nexus-db`, `opencode-executor`, `nexus-executor` all `active (running)`, `NRestarts=0` |
| Client diagnostics | The `src/gateway.ts` close-code/reason/socket-error logging + backoff fix (uncommitted) is working as designed — it is what produced the numbers above |

Note: **enrollment succeeded 2026-10-09 02:20 through the same public
endpoint**, so the platform path worked for `enroll` then. What fails now is
`connect` (auth + session open) — a different hub operation.

### 2.1 `make repair` — the executor-side differential probe (2026-10-13 01:50)

`nexus-executor repair` (new; `make repair`) runs the static checks, then
dials `/v1/connect` twice — once with our real proof, once with well-shaped
garbage — and classifies the difference:

```text
static checks    all PASS (config, identity keypair, cli state, NTP,
                 database, opencode, all three services)
connectivity     dns OK · POST /v1/enroll → 400 (chain alive) · skew −1 s
session probes
  connect valid    closed 1011 after 327 ms          ← the failure
  connect invalid  upgrade rejected (HTTP 401)       ← the auth layer works
diagnosis: hub-session-open-failure
```

Interpretation — per the protocol design the gateway validates nothing but
shapes, and the garbage probe is shape-canonical, so that 401 is the hub's
denial (confirm with command 7's nonce rows, but the signature is clean):

- the hub is **up** and its auth path executes: `loadDevice` read
  `builder.gateway_devices` and denied the unknown credential cleanly. A
  missing/unreadable `gateway_devices` table would have made the invalid
  probe fail the *same* way as the valid one (both 1011).
- our credential/proof is **accepted** — the valid probe completes the
  upgrade.
- what errors is the call **after** auth: the session-open path
  (`builder.gateway_sessions` insert / lease) — hypothesis 1.

This is the remote equivalent of decision-table row 7's `nonces_last_hour >
0` branch. The §4 commands now answer *why* session-open errors, not *where*
the failure is.

## 3. Hypotheses, in priority order

1. **Hub transport 500 on connect / session-open** — the hub's recurring
   "missing-migration 500" class (see the hub repo's `AGENTS.md` incident
   table). Gateway tables land in `builder/020_executor_gateway.sql` (newest
   migration, landed 2026-10-07). Enrollment on Oct 9 proves 020 was applied
   *then*; a later redeploy or DB restore may have regressed it. Commands 5–6
   decide.
2. **The ~23:05 gateway event** — if the gateway's `ActiveEnterTimestamp` ≈
   23:05, it was down before that (the 502 window) and something brought it up.
   What it logged on its first connects after that decides.
3. **Data-specific breakage for this executor** — `7220ff71` ("home", on the
   server) held live sessions on 2026-10-08. If it *still* connects while ours
   fails, the fault is specific to our executor's rows / session-open rather
   than platform-wide. The nonce check (command 7) is the sharpest
   discriminator:
   - **Fresh nonce rows for our device** → auth *succeeds*; the 500 is in
     session `open` (the `builder.gateway_sessions` path).
   - **No nonce rows** → the hub 500s *before/at* `loadDevice` (auth never
     completes).

### 3.1 What `make pair` does (and does not) do

`make pair` / `nexus-executor pair` is **idempotent**: `enrollGateway` returns
the existing identity if `gateway-identity.json` is present and well-shaped —
it does **not** contact the gateway, consume a pairing code, or change
anything on the hub. Verified 2026-10-13 01:13: `make pair` printed
`Paired "office-agent" … (executor 97afab48-…)` with the **same** executorId
and `enrolledAt 2026-10-08T20:50:21Z`; the identity file's mtime was
untouched. A service restart afterwards (01:12) also changed nothing — the
1011 loop persisted with identical signatures.

A **fresh** re-pair (new keypair → new hub executor row) is a legitimate
remote diagnostic when server access is inconvenient, because enrollment
exercises the hub's device tables end-to-end (pairing-code claim, executor
row, device row):

- fresh enroll **succeeds** + connect still 1011s → the hub's **session-open**
  path is broken (confirms hypothesis 1/3 server-side);
- fresh enroll **fails** → the hub DB / pairing tables are broken more broadly.

Procedure (from `2026-10-08-gateway-executor-auth-failure.md` — the identity
deletion is mandatory, or the enroll silently reuses the old key):

```bash
systemctl --user stop nexus-executor
rm -f ~/nexus-executor/data/gateway-identity.json ~/.config/nexus-executor/state.json
# Mint a fresh single-use code: hub console → Builder → Executors → Pair executor
nexus-executor pair --gateway https://nexus-executor.abhirajtomar.com --code <CODE>
systemctl --user start nexus-executor
```

Cost: creates a **new** executor row on the hub (the old `97afab48…` row
lingers — revoke it there afterwards). Note our signature (`hub_failure`, not
`authentication_failed`) does **not** match the stale-identity pattern that
runbook fixed, so a re-pair is a diagnostic here, not the expected cure.

## 4. Server-side evidence to collect (run as `server@abhiraj`)

```bash
# 1) The 23:05 transition — what the gateway did during the 502 window,
#    and what event marked the switch to 1011
journalctl -u nexus-gateway --since "2026-10-12 22:40" --until "2026-10-12 23:15" --no-pager | tail -60

# 2) Recent connect attempts (the executor retries every ~10–30 s) + unit state
journalctl -u nexus-gateway --since "-25 min" --no-pager | tail -40
systemctl show nexus-gateway -p ActiveState,SubState,ActiveEnterTimestamp,NRestarts,ExecMainStatus

# 3) All three listeners up? (gateway :3100, hub transport :3201, hub :3999)
ss -ltnp | grep -E ':3100|:3201|:3999'

# 4) Hub side — errors from the private transport listener when connects arrive
journalctl --user -u nexus --since "2026-10-12 23:04" --no-pager | grep -iE 'gateway|transport|error|denied|500' | tail -60

# 5) Hub health — the migrations.{bootApplied,bootError} block is the
#    missing-migration check
curl -s http://127.0.0.1:3999/health; echo

# 6) DB truth — is builder migration 020 applied on the live hub database?
cd /home/server/services/deployments/nexus && set -a && . ./.env && set +a
node -e 'const{Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query("SELECT version FROM platform.schema_migrations WHERE module_id=$1 ORDER BY version DESC LIMIT 6",["builder"])).then(r=>{console.log(r.rows);return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})'

# 7) This executor's device/session/nonce rows — did auth ever complete?
node -e 'const{Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query("SELECT d.device_id, d.protocol_version, d.expires_at, d.revoked_at, e.status, e.name, (SELECT count(*) FROM builder.gateway_nonces n WHERE n.device_id=d.device_id AND n.seen_at>NOW()-interval '\''1 hour'\'') AS nonces_last_hour, (SELECT max(s.last_seen) FROM builder.gateway_sessions s WHERE s.executor_id=d.executor_id) AS last_session FROM builder.gateway_devices d JOIN builder.executors e ON e.id=d.executor_id")).then(r=>{console.log(r.rows);return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
```

Optional full-path verdict (spins scratch databases, does not touch prod data):

```bash
cd /home/server/services/nexus && node_modules/.bin/tsx .smoke/gateway-smoke.mts   # expect: SMOKE PASS
```

## 5. Decision table

| Command | If it shows… | Then… |
|---|---|---|
| §2.1 (done) | `make repair` → `hub-session-open-failure` | Auth passes; failure is in session `open` — the same branch as row 7's `nonces > 0`. §4 now explains the *why* |
| 1–2 | `startup_failed` / crash-loop before 23:05, or an `error`/`operation` field on `hub_failure` | We get the gateway's real failure directly (richer still if the 2026-10-10 logging patch was applied to `/opt/nexus-gateway/dist/src/hub/client.js`) |
| 2 | `ActiveEnterTimestamp` ≈ 2026-10-12 23:05 | The gateway itself restarted then — find why (unit restart, crash-loop exit, server reboot) |
| 3 | `:3201` missing | The hub's private transport listener is down → every connect is a `hub_failure` by definition |
| 4 | A 500 / stack trace on `/transport` | Hub-side throw — hypothesis 1 or 3 |
| 5 | `migrations.bootError`, or `bootApplied` not listing `020` | Confirms the missing-migration hypothesis; fix is `npm run migrate` on the deployment |
| 6 | No `020` row | Smoking gun — same fix as above |
| 7 | `nonces_last_hour > 0` for `97afab48…` | Auth succeeds; failure is in session `open` (`builder.gateway_sessions` path) |
| 7 | `nonces_last_hour = 0` and `last_session` old/NULL | The hub 500s before nonce insert — inspect `loadDevice` / `gateway_devices` |

## 6. Executor-side follow-ups (independent of the server fix)

- Commit the `src/gateway.ts` diagnostics + backoff fix (close code/reason/
  socket error in the reconnect log; short-lived sessions no longer reset the
  backoff — `STABLE_SESSION_MS = 30_000`). It is what made this runbook's
  numbers possible.
- `nexus-executor repair` / `make repair` (new, 2026-10-13): static checks +
  the valid/garbage differential probe + verdict-keyed fix suggestions
  (`src/cli/repair.ts`, tests `src/cli/repair.test.ts`, README §Control CLI,
  `buildConnectHeaders` extracted from the loop so the CLI and runtime share
  one proof implementation). It produced §2.1 — commit alongside the gateway
  diagnostics.
- The installer work from 2026-10-12 (native `nexus-db`, password pinning,
  backup/migration paths in `scripts/install.mjs`) is complete and verified —
  commit it as the session that produced it died before doing so.

## Related

- `docs/runbooks/2026-10-08-gateway-executor-auth-failure.md` — the
  `authentication_failed` executor (`65548050`, stale identity). Different
  failure mode, different executor; do not conflate.
- Hub-side operator runbook: `~/services/nexus/docs/nexus-executor-gateway-setup.md`
  (architecture: Cloudflare → cloudflared → Caddy → gateway :3100 → hub
  transport :3201; §5 is the end-to-end smoke test).
- Hub connect-auth code: `modules/builder/src/gateway.ts`
  (`authenticateGatewayDevice` — a denial throws `GatewayDenied` ⇒ hub answers
  401 ⇒ gateway logs `authentication_failed`; any other throw ⇒ 500 ⇒
  `hub_failure` ⇒ the executor sees 1011).
- 2026-10-10 opencode session "Nexus executor gateway session keeps
  disconnecting" — first instrumentation pass and server-side dig.
