# nexus-executor

A small, standalone **agent runner** for the Nexus hub. It is deployed on a
*remote* machine (an office box, a build server behind NAT), pairs with the
hub once, and then receives "jobs" (build tasks) from the hub over
authenticated HTTP. Each job runs locally by driving a local
[OpenCode](https://opencode.ai) V2 server (`opencode serve`) in an isolated
git worktree, with its own state in its own Postgres database. The hub polls
back for status and events.

This package is fully self-contained: its own package.json + lockfile,
tsconfig, migrations, tests, Dockerfile — **zero imports** from the hub
monorepo. It is adapted from the hub's `modules/builder` engine pieces
(OpenCode client, worktree isolation, stall detection, verification
semantics); **the hub's `modules/builder` remains the source of truth** —
port behavior changes from there deliberately, and keep the event-type
vocabulary aligned.

## Security model

One-way trust:

- **Pairing hands the executor a bearer token exactly once.** The executor
  stores only the token's SHA-256 hex digest; the raw token is never written
  to the executor's database, disk, or logs. A leaked executor database
  cannot impersonate the hub.
- **The hub dials the executor, never the other way around.** After the
  one-shot pairing call, the executor makes no outbound calls to the hub —
  it only answers authenticated requests. Every `/api/v1/*` request must
  carry `Authorization: Bearer <token>` (digests compared in constant time);
  `/health` is public.
- **The executor's state database is its own** (`nexus_executor` or similar)
  — never the hub's database.
- **Job attachments are decrypted material for the agent only**: they are
  written into the job worktree's `builder-input/` directory, which is added
  to the repo's git exclude **before any file lands** — user files can never
  be committed, merged, or deployed.

## Prerequisites

- **Node.js ≥ 22** and **git** on the executor machine.
- **Postgres** (any recent version; the compose stack ships postgres:16).
- **`opencode serve`** running on the executor machine (or reachable from
  it), with `OPENCODE_SERVER_PASSWORD` pinned on the service so the token
  survives service restarts, and your provider keys configured
  (`OPENCODE_TOKEN` = that password, or a `Basic …`/`Bearer …` scheme string
  for a gateway in front).

## Quickstart — bare metal

```bash
make install                 # npm ci
cp .env.example .env         # then edit DATABASE_URL, OPENCODE_*, HUB_URL, PAIR_CODE, EXECUTOR_PUBLIC_URL
make migrate                 # apply src/migrations to DATABASE_URL
make pair                    # one-shot pairing with the hub (needs HUB_URL + PAIR_CODE + EXECUTOR_PUBLIC_URL)
make build
make start                   # node --env-file=.env dist/main.js
```

`make dev` runs the same server via tsx with watch mode. `make test` runs
the suite (it needs a reachable Postgres; see Testing below).

## Gateway transport and Podman on the office box

For outbound-only operation behind NAT, use:

```ini
EXECUTOR_TRANSPORT=gateway
GATEWAY_URL=https://nexus-executor.abhirajtomar.com
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_TOKEN=<local OpenCode server password>
```

The gateway URL is a base URL, without `/v1/enroll` or `/v1/connect`.
Gateway mode uses an Ed25519 identity and an outbound WebSocket; the
dial-back bearer-token security model above describes **direct mode**.
Full office-box/OpenCode instructions:
[gateway setup runbook](../docs/nexus-executor-gateway-setup.md).

Recommended layout: **Postgres in Podman; executor and OpenCode on the host**.
The supplied Compose database has no published host port. Before running
host `make` commands, add this to the `db` service in `docker-compose.yml`:

```yaml
    ports:
      - "127.0.0.1:5544:5432"
```

```sh
podman compose stop executor
podman compose up -d db
podman compose exec db pg_isready -U nexus_executor -d nexus_executor
podman compose port db 5432
```

Wait for Postgres to accept connections, then set the host `.env`:

```ini
DATABASE_URL=postgres://nexus_executor:nexus_executor@127.0.0.1:5544/nexus_executor
```

Run `make migrate`, set a fresh `PAIR_CODE`, then run `make pair`,
`make build`, and `make start`. **Pairing exits after enrollment**; Nexus
stays offline until the running executor logs `gateway session established`.
Keep `make start` running, or supervise the host executor with systemd.

## Quickstart — Docker / Podman (containerized executor)

```bash
cp .env.example .env         # fill in OPENCODE_*, HUB_URL, PAIR_CODE, EXECUTOR_PUBLIC_URL
docker compose up --build -d # or: make docker-up
```

The compose stack runs this image plus a `postgres:16` sidecar with a
private network; the executor **applies its migrations at boot**, so
restarting onto a new image is the whole upgrade story. Pairing still needs
to happen once: either set `PAIR_CODE` in `.env` (the boot consumes it), or
run `podman compose exec executor npm run pair` inside the running executor
(use `docker` in place of `podman` for Docker). Host `make pair` does not
inherit Compose's database override or container identity. Job workspaces persist in
the `executor-workspaces` volume; the database in `pgdata`.

For a containerized executor, configure OpenCode networking and storage
before using this recipe: container `127.0.0.1:4096` is not the host's
OpenCode listener. Both processes must see job workspaces at the **same
absolute paths**. A host OpenCode bound only to loopback also cannot simply
be reached by changing the URL to `host.containers.internal`. Provide a
reachable endpoint and matching shared mounts, or keep both processes on
the host as above. Mount the gateway identity persistently at
`GATEWAY_IDENTITY_PATH`, or enroll the container separately; host enrollment
is not automatically copied into the container.

## Pairing walkthrough

1. **On the hub**: open Builder → Executors → "Pair executor" and copy the
   one-shot code.
2. **On the executor machine**: fill `.env` — `HUB_URL` (the hub's address),
   `PAIR_CODE` (the code), `EXECUTOR_PUBLIC_URL` (the address the hub should
   dial back), and `EXECUTOR_NAME` (defaults to the hostname).
3. Run `make pair` (or just start the server with `PAIR_CODE` set — the
   boot claims it when no auth row exists). You should see:
   `paired with hub as "office-box" (id …)`.
4. From then on the executor answers the hub's authenticated calls.
   Re-running `make pair` while paired is a no-op.

**Re-pairing after a revoke**: revoke the executor on the hub, delete the
auth row (`DELETE FROM executor.config WHERE key = 'auth'`), then pair again
with a fresh code.

## Networking over Tailscale / ZeroTier

Both machines behind NAT? Install tailscale (or ZeroTier) on both, keep the
executor bound to `0.0.0.0:4099`, and use the machine's tailnet address as
`EXECUTOR_PUBLIC_URL`, e.g. `http://office.tail1234.ts.net:4099`. Plain HTTP
inside a tailnet is acceptable — the bearer token does the authentication
and the overlay does the encryption. Only switch to HTTPS (a reverse proxy
in front) if you expose the executor publicly.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | **(required)** | The executor's own Postgres database. |
| `PORT` | `4099` | Listen port. |
| `HOST` | `0.0.0.0` | Listen host. |
| `LOG_LEVEL` | `info` | pino level. |
| `EXECUTOR_NAME` | hostname | Shown on the hub next to jobs. |
| `EXECUTOR_PUBLIC_URL` | — | The URL the hub dials back; **required for pairing**. |
| `HUB_URL` | — | Hub base URL for the one-shot pairing call. |
| `PAIR_CODE` | — | One-shot code, consumed at boot (or via `make pair`) when unpaired. |
| `OPENCODE_BASE_URL` | — | `opencode serve` URL; **required to run jobs** (jobs queue without it). |
| `OPENCODE_TOKEN` | — | The service's pinned password (`opencode:<token>` over Basic), or a full scheme header. |
| `OPENCODE_AGENT` | `build` | Session agent. |
| `EXECUTOR_WORKSPACE_ROOT` | `<cwd>/data/workspaces` | `repos/` (clones) + `worktrees/` (per-job) live here. |
| `EXECUTOR_BASE_REF` | `''` | Branch to merge into; empty = the repo's own default branch. |
| `EXECUTOR_DEPLOY_COMMAND` | `''` | Run in the repo checkout after a merge; empty = no deploy. |
| `EXECUTOR_MAX_PARALLEL_JOBS` | `1` | Job slots. |
| `EXECUTOR_POLL_INTERVAL_MS` | `2000` | Worker tick. |
| `EXECUTOR_TOOL_STALL_MINUTES` | `50` | One tool call may not run longer. `0` disables. |
| `EXECUTOR_STALL_MINUTES` | `20` | An in-flight turn with zero session activity fails after this. `0` disables. |
| `EXECUTOR_TOOL_PROGRESS_MINUTES` | `10` | A tool whose output stopped changing for this long fails the job fast (the wedged-call signature). `0` disables. |
| `EXECUTOR_JOB_TIMEOUT_MINUTES` | `120` | Started-job ceiling; `waiting_for_user` is exempt. `0` disables. |
| `EXECUTOR_RETRY_MAX` | `3` | Total attempts a job gets after a retryable failure **when the dispatch pinned no budget** (the hub's `retry.maxAttempts` always wins). `1` = retries off. |
| `EXECUTOR_RETRY_DELAY_MINUTES` | `2` | Minutes between a retryable failure and the requeued attempt. `0` = next tick. |

Keep the tool-stall ceiling under the OpenCode service's 60-minute
location-inactivity window, which kills such turns anyway.

## API reference

Base `/api/v1`, `Authorization: Bearer <token>` on everything except
`/health`. Bodies are JSON; errors are `{error: string}` with a fitting
status.

| Route | Behavior |
| --- | --- |
| `GET /health` | Public. `{ok, db:'up'\|'down', name, paired}`; 503 when the db is down. |
| `GET /api/v1/status` | `{ok:true, name, version, paired:true, opencode:{configured,baseUrl}, jobs:{active,queued,total}, capabilities:{jobRetries,modelFallback}, uptimeSeconds}`. |
| `GET /api/v1/models?directory=` | `{items:[{id,name,provider}]}` from the OpenCode service; 503 when unconfigured. |
| `POST /api/v1/jobs` | Create a job. Body `{jobId, title?, prompt, verificationCommand?, project:{name?, repoUrl?, localPath?, buildCommand?, runCommand?, testCommand?, customPrompt?}\|null, models?: string[], attachments?: [{name,mimeType,dataBase64}], retry?: {maxAttempts: 1..10, delayMinutes: 0..60}}`. Caps: prompt ≤ 200k chars, ≤ 10 attachments, ≤ 25 MB total attachment bytes. **Idempotent on `jobId`** (existing job → 200 `{job}`, no duplicate). New job → 201 `{job}`; admitted immediately when a slot is free, else `queued`. `retry` pins the in-job retry budget (absent = `EXECUTOR_RETRY_MAX`/`EXECUTOR_RETRY_DELAY_MINUTES`). |
| `GET /api/v1/jobs?status&limit&updatedSince` | `{jobs:[JobSummary]}` ordered by `updated_at` ascending. `limit` ≤ 500 (default 100); `updatedSince` is an ISO lower bound (exclusive). JobSummary: `{id, hubJobId, status, title, failureReason, errorCode, attemptCount, maxAttempts, mergedSha, createdAt, startedAt, finishedAt, updatedAt}`. |
| `GET /api/v1/jobs/:jobId` | JobSummary + `{branch, worktreePath, opencodeSessionId, model, summary, verification:{attempts,lastExitCode,lastOutputTail}, eventCount}`. 404 unknown. |
| `GET /api/v1/jobs/:jobId/events?sinceSeq=0&limit=200` | `{events:[{seq,type,source,summary,payload,createdAt}]}` ascending by `seq`, `seq > sinceSeq`, limit ≤ 500. |
| `POST /api/v1/jobs/:jobId/message` | `{text ≤ 50k}` — prompts the job's SAME OpenCode session, parks resume to `running`, records a `HUB_MESSAGE` event. `{ok:true}`; 409 on terminal jobs. |
| `POST /api/v1/jobs/:jobId/cancel` | Interrupts the session best-effort, marks `cancelled` (unless already terminal). `{job}`; 200 even when already terminal — idempotent. |
| `POST /api/v1/jobs/:jobId/verify` | Re-runs the verification command (from `failed`/`succeeded`): status `verifying`, then `succeeded` or `failed` (`verification_failed`). 409 when created/queued/running or commandless. `{job}`. |
| `POST /api/v1/jobs/:jobId/merge` | Only `succeeded` jobs with a branch. Safety-net commit first (unresolved conflicts → 409 `{error, conflicts}`), then a tree-less `merge-tree` + `commit-tree` + CAS `update-ref` into the base ref. Success: `{merged:true, mergeSha, baseRef}`; already-contained: `{merged:true, mergeSha:<branch tip>, alreadyContained:true}`; conflicts: 200 `{merged:false, conflicts, error, baseRef}`; deploy failure adds `deployError`. The workspace is removed afterwards. |
| `GET /api/v1/jobs/:jobId/log` | `{gone:true}` after cleanup, else `{branch, commits:[{sha,subject,at}], status}` (commits on the branch since the snapshot base + porcelain status). |
| `PUT /api/v1/config` | `{systemPrompt?, defaults?, models?}` — upserts the executor's stored config (the hub pushes its canonical values here). `{ok:true}`. |

Management commands: `make migrate` applies `src/migrations`; `make pair`
runs the pairing claim; `make dev`/`make start` run the server.

## Job lifecycle

```
 POST /jobs ──► created ──admit──► running ─┬─ question ─► waiting_for_user ──message──► running
      (queued until a slot frees)            │
                                             ├─ verificationCommand set ─► verifying ─┬─ pass ─► succeeded
                                             │                                        └─ fail ─► repair prompt ─► running (≤3 attempts, else failed)
                                             ├─ stalled/timeout/errored ─► failed
                                             ├─ cancel ─► cancelled
             succeeded ──/merge──► branch lands on the base ref, optional deploy, workspace removed
```

One job = one OpenCode session per ATTEMPT: repairs and hub messages
re-enter the attempt's session, while a retry mints a fresh one. After
every completed agent turn the worktree is safety-committed to the job's
branch, so a crash or an interrupted turn never loses landed work — and a
retry RESUMES that branch (a continuation preamble tells the fresh session
what already landed) instead of starting over. Retries: failures with a
retryable code (stalls, errored turns, timeouts, session-setup hiccups)
requeue up to the job's attempt budget (`retry.maxAttempts` from the
dispatch, else `EXECUTOR_RETRY_MAX`); the timeline narrates
`AUTO_RETRY_SCHEDULED`/`AUTO_RETRY_STARTED` and exhaustion fails the job as
`remote_retry_exhausted` with the attempt counting on the summary — the hub
folds that without re-retrying (it pinned the budget at dispatch; only
infrastructure losses and pre-0.2.0 executors get the hub's own cross-run
retry). A turn dying on a provider usage limit switches to the next model
of the dispatch's priority list instead (`MODEL_FALLBACK`, once per limit).
Event types follow the hub's builder vocabulary
(`SESSION_CREATED`, `PROMPT_SENT`, `AGENT_MESSAGE`, `TOOL_CALL_*`,
`VERIFICATION_*`, `EXECUTION_*`, `WORKTREE_*`, …) so the hub can render
executor timelines with the same components.

Stall guards mirror the hub's: a tool past `EXECUTOR_TOOL_STALL_MINUTES`, a
silent in-flight turn past `EXECUTOR_STALL_MINUTES`, or a tool with no output
progress for `EXECUTOR_TOOL_PROGRESS_MINUTES` (fingerprint comparison across
polls — a call marked running that never executes fails fast) all interrupt
the session and fail the job as `agent_stalled`. Started jobs die at
`EXECUTOR_JOB_TIMEOUT_MINUTES` as `execution_timeout` (`waiting_for_user`
parks are exempt).

## Operations

- **Health**: `GET /health` (`db` is `down` with 503 when Postgres is
  unreachable). Logs are pino JSON on stdout (`LOG_LEVEL`).
- **Worker errors** are logged, never fatal; the poll loop always continues.
- **Where is a job's work?** `GET /api/v1/jobs/:id/log` (branch + commits +
  porcelain status) while the worktree exists; after a merge the workspace
  is removed and the merge sha is recorded on the job.
- **Re-pairing after revoke**: revoke on the hub, `DELETE FROM
  executor.config WHERE key = 'auth'`, run `make pair` with a fresh code.
- **Restarting**: in-flight agent turns live in the OpenCode service, not
  this process; on boot the worker re-adopts jobs with sessions and resumes
  polling them.

## Testing

```bash
# one-time: a throwaway database (the suite recreates the schema itself)
psql "$SERVER" -c 'CREATE DATABASE nexus_executor_test'  # or use the compose db
DATABASE_URL=postgres://nexus:nexus@localhost:5544/nexus_executor_test npm test
```

`vitest.setup.ts` refuses to run against any database whose name does not
end in `test`/`_test` — the suites create and destroy real tables (this
guard exists because of a real cross-contamination incident on the hub).
The OpenCode side is a scripted in-memory stub (injectable fetch); git
worktrees and merges run against real temporary repositories.
