# Runbook — Executor `65548050` continuously fails gateway auth

**Date:** 2026-10-08
**Status:** Remediation required on the executor host (not on this server)
**Owner of the broken executor:** device `a93f7a68-1095-4a25-a424-1e46fb3d89f2` (remote host)

## TL;DR

The live platform (gateway + hub transport + DB + protocol) is **verified healthy**. The symptom "Executor is offline (no live gateway session)" for gateway executor **`65548050`** is caused by that executor presenting a **stale / mismatched Ed25519 identity** (its stored private key or credential no longer matches the hub's enrolled public key / credential hash). Its handshake is rejected **at signature verification**, which is why the gateway journal shows a continuous `authentication_failed` streak and why no nonce is ever consumed.

**Fix: re-pair / re-enroll executor `65548050` on its own host.** Because `enrollGateway` reuses an existing valid identity, re-pairing requires **removing the stale identity and CLI state first**, then enrolling with a **fresh single-use pairing code**.

---

## Evidence (collected live on the server)

All of the following was verified against the running system, not by code inspection alone.

| Check | Result |
|---|---|
| Hub transport `authenticate` (valid proof, executor `7220ff71`) | HTTP **200**, full identity returned |
| Real WS handshake `ws://127.0.0.1:3100/v1/connect` (executor `7220ff71`) | **OPEN accepted**, session registered, `status.get` delivered |
| Deployed `/opt/nexus-gateway/dist` `PROOF_AUDIENCE` | `NEXUS-GATEWAY-CONNECT v1` — matches hub + executor |
| Deployed hub `.../modules/builder/dist/gateway.js` patterns | `CREDENTIAL_PATTERN /^[A-Za-z0-9_-]{32}$/`, proof/nonce patterns identical across all three |
| `65548050` (device `a93f7a68`) real sessions in `builder.gateway_sessions` | **0** (only a `99999999-…` smoke-test placeholder) |
| `65548050` nonce consumption | **1 nonce, Oct 07 23:14** — none since |
| `65548050` last real activity | executor row `last_seen_at 2026-10-08 04:29:05` |
| `7220ff71` (after starting its loop) | **LIVE session**, `last_seen` refreshing continuously |

### Why this points to a key/credential mismatch (not a platform bug)
- The hub rejects `65548050` **at signature verification** for its proof. In `authenticateGatewayDevice` the Ed25519 verify (`ed25519Verify(null, signed, createPublicKey(public_key_pem), signature)`) runs **before** the nonce insert; a failed verify throws `GatewayDenied` → the hub answers 401 → the gateway logs `authentication_failed`, and **no nonce row is written**. That is exactly the observed pattern (empty nonce table for `a93f7a68`, continuous `authentication_failed`).
- A valid proof from a correctly-enrolled identity (`7220ff71`) is accepted end-to-end, proving the platform path is sound.

### Conclusion
`65548050`'s stored **private key no longer corresponds** to the hub's enrolled `public_key_pem` for device `a93f7a68` (or its stored credential no longer hashes to the DB's `credential_hash`). Root cause is on the executor host.

---

## Fix: re-pair executor `65548050`

### Prerequisites on the server / hub side
1. **Mint a fresh, single-use pairing code**
   — Builder → Executors → (executor) → create a pairing code.
   - Pairing codes are single-use and carry a 15-minute TTL. The last known code `UKDCZWEG` is **expired**.
   - The code is consumed by the successful enrollment; recovery after a lost response is always a **new** pairing code.
2. **(Recommended) Revoke / disable the stale `65548050` row** after confirming the re-pair produced a new executor, to avoid a dangling offline row. A re-enroll creates a **new** `builder.executors` row (new executorId) and a **new** device row; the old `65548050` / `a93f7a68` rows remain unless cleaned up.

### On the executor host (`65548050`)
The steps below must be run **on the machine that runs the broken executor**, in its checkout directory (where `dist/main.js` and its `.env` live).

1. **Stop the executor** (service / PID / supervisor) so it stops hammering the gateway with bad proofs.
2. **Remove the stale identity and CLI state** so the next boot will re-enroll instead of reusing the broken identity:
   ```bash
   # Determine the identity path (env GATEWAY_IDENTITY_PATH overrides the default).
   # Default location (workspace root):  <workspace-root>/data/gateway-identity.json
   #   (config.ts: gatewayIdentityPath = GATEWAY_IDENTITY_PATH || <workspaces>/../gateway-identity.json)
   #
   # Remove the durable identity (mode 0600):
   rm -f /path/to/gateway-identity.json

   # Remove the CLI pairing-state index (stores the gateway URL / identity path too):
   #   ~/.config/nexus-executor/state.json   (or $NEXUS_EXECUTOR_STATE if set)
   rm -f ~/.config/nexus-executor/state.json
   ```
   > **Important:** `enrollGateway` (gateway.ts) returns immediately with the **existing** identity if `gateway-identity.json` is present and shaped correctly. If you skip this deletion, `npm run pair` / boot will silently reuse the stale key and the auth failure will persist. This is the single most common reason a re-pair "doesn't take".
3. **Confirm the executor is in gateway mode and pointed at the right gateway:**
   ```bash
   grep -E '^(EXECUTOR_TRANSPORT|GATEWAY_URL|GATEWAY_IDENTITY_PATH)=' .env
   # expect EXECUTOR_TRANSPORT=gateway and GATEWAY_URL=<the Cloudflare/gateway endpoint>
   ```
4. **Enroll with the fresh pairing code (non-interactive):**
   ```bash
   node --env-file=.env dist/main.js pair --gateway "$GATEWAY_URL" --code "<NEW_PAIRING_CODE>"
   # or, interactively:
   npm run pair
   ```
   On success the executor writes a **new** `gateway-identity.json` (new credential + new Ed25519 keypair) and a new CLI state.
5. **Verify the new identity locally:**
   ```bash
   node --env-file=.env dist/main.js status --json
   ```
   Confirm a new `executorId` and `enrolledAt` (fresh).
6. **Start the executor** (same supervisor/service as before). Watch its log for:
   ```
   enrolled with gateway {executorId: <new-id>}
   gateway session established
   ```
7. **Confirm on the hub side:**
   ```sql
   -- Expect a NEW builder.executors + builder.gateway_devices row for this host,
   -- and then a LIVE session within seconds:
   SELECT s.executor_id, s.session_id, s.last_seen, s.closed_at
   FROM builder.gateway_sessions s
   WHERE s.executor_id = '<new-executor-id>'
     AND s.closed_at IS NULL;
   -- last_seen should be < 90s old and closed_at NULL -> connected (per gateway-health)
   ```

### Acceptance criteria
- Gateway journal stops emitting continuous `authentication_failed` for this executor (only normal connect/disconnect after this).
- `builder.gateway_nonces` shows fresh rows for the new device whenever it authenticates.
- Builder UI reports the executor **online** with a live gateway session; dispatching a job reaches it.

---

## Verification commands used to establish root cause (for reference)

```sql
-- Live sessions within the 90s lease (gateway-health definition of "connected")
SELECT s.executor_id, e.name, s.session_id, s.last_seen, s.closed_at
FROM builder.gateway_sessions s
JOIN builder.executors e ON e.id = s.executor_id
WHERE s.closed_at IS NULL AND s.last_seen > NOW() - interval '90 seconds';
```

```sql
-- Identity/credential consistency vs. the executor's stored identity
-- (compare public_key_pem and credential_hash to the host's gateway-identity.json)
SELECT d.executor_id, d.device_id, d.public_key_pem, d.credential_hash,
       d.protocol_version, d.expires_at, d.revoked_at, e.status
FROM builder.gateway_devices d
JOIN builder.executors e ON e.id = d.executor_id;
```

> Do **not** re-pair `7220ff71` (device `99e24d85`, "home") — its identity is valid and is currently holding a live session. The guidance above is specific to the broken **`65548050`** executor.

---

## Related notes
- The other gateway executor (`7220ff71`, "home", on this server) was **not broken** — it showed offline only because no executor process was running. Its loop was started (see session log) and it now reports `connected=true`. Do not conflate the two.
- The `99999999-…` session ID seen for `65548050` is a **smoke-test artifact**, not a Gateway-registered session; ignore it when reading `gateway_sessions`.