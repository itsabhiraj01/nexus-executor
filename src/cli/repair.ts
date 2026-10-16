import { execFileSync } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { Client } from 'pg';
import { EXECUTOR_VERSION, loadConfig, type ExecutorConfig } from '../config.js';
import { buildConnectHeaders, readGatewayIdentity, type GatewayIdentity } from '../gateway.js';
import { readCliState } from '../pairing/state.js';

/**
 * `nexus-executor repair` — diagnose the full connectivity chain
 *
 *   executor → Cloudflare → cloudflared → Caddy → nexus-gateway → hub
 *
 * in two layers: static checks (config, identity, local services, clock)
 * and live probes. The probes are the interesting part — both dial
 * `/v1/connect`, one with this executor's REAL proof and one with
 * well-shaped GARBAGE (a credential that cannot exist). Comparing the two
 * localizes the failure without server access:
 *
 *   valid → 1011 fast close, invalid → rejected (1008 authentication_failed)
 *     ⇒ auth works; the hub call behind session-open errors (server-side).
 *   valid → 1011 fast close, invalid → the SAME 1011 fast close
 *     ⇒ the gateway's hub call fails before/regardless of auth (hub down,
 *       gateway→hub link, or the hub's gateway tables fail to read).
 *   valid → rejected
 *     ⇒ this executor's identity is stale/revoked — re-pair.
 *   valid → open for the whole hold window
 *     ⇒ the chain is healthy end to end.
 *
 * The valid probe opens a REAL session and holds it `--hold-ms` (default
 * 3s — long enough to rule out the ~300ms failure signature, short enough
 * not to disturb a healthy service loop, which reconnects on its own if
 * the hub leases the session to the probe). The probe never answers
 * gateway requests: run it when the executor is idle if you are worried
 * about a job being routed to a socket that will not reply.
 *
 * Exit code 0 = healthy (verdict `healthy`, no failed checks); 1 = fixable
 * findings. `--json` emits the structured report.
 */

const RUNBOOK = 'docs/runbooks/2026-10-13-gateway-1011-hub-failure.md';
const REPAIR_RUNBOOK = 'docs/runbooks/2026-10-08-gateway-executor-auth-failure.md';
/** The hub rejects connect proofs outside this window (mirrors its tolerance). */
const PROOF_WINDOW_MS = 120_000;
/** systemd user units the native installer owns. */
const SERVICE_UNITS = ['nexus-db', 'opencode-executor', 'nexus-executor'];

// ---------------------------------------------------------------- types

export type RepairCheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface RepairCheck {
  id: string;
  section: 'static checks' | 'connectivity' | 'session probes';
  label: string;
  status: RepairCheckStatus;
  detail: string;
  fix?: string;
}

/** One /v1/connect attempt, observed from open to close. */
export interface ProbeOutcome {
  opened: boolean;
  closeCode: number | null;
  closeReason: string;
  /** HTTP status when the server rejected the WebSocket upgrade itself. */
  httpStatus: number | null;
  error: string | null;
  heldMs: number;
  /** Held open for the whole probe window — the healthy signature. */
  stable: boolean;
}

/** The POST /v1/enroll route probe (malformed body, expects 400). */
export interface RouteOutcome {
  status: number | null;
  dateSkewMs: number | null;
  error: string | null;
}

export type RepairVerdict =
  | 'healthy'
  | 'not-paired'
  | 'direct-transport'
  | 'misconfigured'
  | 'network-unreachable'
  | 'route-missing'
  | 'gateway-origin-down'
  | 'identity-rejected'
  | 'hub-call-failure'
  | 'hub-session-open-failure'
  | 'inconclusive';

export interface RepairReport {
  version: string;
  gatewayUrl: string | null;
  executorId: string | null;
  transport: 'gateway' | 'direct' | null;
  checks: RepairCheck[];
  route: RouteOutcome | null;
  probes: { valid: ProbeOutcome | null; invalid: ProbeOutcome | null };
  verdict: RepairVerdict;
  diagnosis: string;
  fixes: string[];
  ok: boolean;
}

export interface RepairResult {
  text: string;
  ok: boolean;
  report: RepairReport;
}

/** Injectable seams (tests run hermetically; production uses the defaults). */
export interface RepairDeps {
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
  lookup?: (host: string) => Promise<{ address: string }>;
  exec?: typeof execFileSync;
  databaseCheck?: (databaseUrl: string) => Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------- probes

export async function probeRoute(gatewayUrl: string, fetchImpl: typeof fetch): Promise<RouteOutcome> {
  try {
    const res = await fetchImpl(`${gatewayUrl}/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}', // deliberately malformed — a live route answers 400, a missing one 404
      signal: AbortSignal.timeout(10_000),
    });
    const date = res.headers.get('date');
    return { status: res.status, dateSkewMs: date ? Date.parse(date) - Date.now() : null, error: null };
  } catch (error) {
    return { status: null, dateSkewMs: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ProbeConnectOptions {
  webSocketImpl?: typeof WebSocket;
  /** How long an open socket must hold to count as stable (default 3000). */
  holdMs?: number;
  /** Overall probe cap (default 15000). */
  timeoutMs?: number;
}

export async function probeConnect(
  url: string,
  headers: Record<string, string>,
  opts: ProbeConnectOptions = {},
): Promise<ProbeOutcome> {
  const Ws = opts.webSocketImpl ?? WebSocket;
  const holdMs = opts.holdMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return await new Promise<ProbeOutcome>((resolve) => {
    let opened = false;
    let openedAt = 0;
    let httpStatus: number | null = null;
    let socketError: string | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let holdTimer: NodeJS.Timeout | undefined;
    const ws = new Ws(url, { headers, maxPayload: 1024 * 1024 });
    const finish = (partial: Partial<ProbeOutcome>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(holdTimer);
      try { ws.terminate(); } catch { /* already gone */ }
      resolve({
        opened,
        closeCode: partial.closeCode ?? null,
        closeReason: partial.closeReason ?? '',
        httpStatus,
        error: partial.error ?? socketError,
        heldMs: opened ? Math.max(0, Date.now() - openedAt) : 0,
        stable: partial.stable === true,
      });
    };
    timer = setTimeout(() => finish({ error: `probe timed out after ${timeoutMs}ms` }), timeoutMs);
    ws.on('open', () => {
      opened = true;
      openedAt = Date.now();
      holdTimer = setTimeout(() => finish({ stable: true }), holdMs);
    });
    ws.on('error', (error: Error) => {
      socketError = error.message;
      const match = /Unexpected server response: (\d{3})/.exec(error.message);
      if (match) httpStatus = Number(match[1]);
      // ws always follows 'error' with 'close', which finishes the probe.
    });
    ws.on('close', (code: number, reason: Buffer) => finish({ closeCode: code, closeReason: reason.toString('utf8') }));
    // Messages are deliberately ignored: the probe must never answer
    // gateway requests — it is an observer, not an executor.
    ws.on('message', () => {});
  });
}

/**
 * Connect headers with well-shaped GARBAGE: canonical nonce/proof lengths,
 * a credential that cannot exist. The gateway's shape checks pass and the
 * hub's verifier rejects it — which is exactly what the differential needs
 * (a shape-rejected probe would prove nothing about the hub).
 */
export function buildInvalidConnectHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${'A'.repeat(32)}`,
    'x-nexus-proof-ts': String(Date.now()),
    'x-nexus-proof-nonce': randomBytes(16).toString('base64url'),
    'x-nexus-proof': randomBytes(64).toString('base64url'),
  };
}

// ---------------------------------------------------------- classification

/** Two probes failed in the same way — the auth layer did not differentiate. */
export function sameFailureSignature(a: ProbeOutcome, b: ProbeOutcome): boolean {
  return a.opened && b.opened
    && a.closeCode !== null
    && a.closeCode === b.closeCode
    && a.closeReason === b.closeReason
    && !a.stable && !b.stable
    && Math.abs(a.heldMs - b.heldMs) < 1500;
}

export function classifyRepair(args: {
  transport: 'gateway' | 'direct' | null;
  hasIdentity: boolean;
  gatewayUrl: string | null;
  route: RouteOutcome | null;
  valid: ProbeOutcome | null;
  invalid: ProbeOutcome | null;
}): RepairVerdict {
  const { transport, hasIdentity, gatewayUrl, route, valid, invalid } = args;
  if (transport && transport !== 'gateway') return 'direct-transport';
  if (!hasIdentity) return 'not-paired';
  if (!gatewayUrl) return 'misconfigured';
  if (route?.status === 404) return 'route-missing';
  if (route && route.status !== null && route.status >= 500) return 'gateway-origin-down';
  if (route?.error) return 'network-unreachable';
  if (!valid) return 'inconclusive';
  if (valid.stable) return 'healthy';
  if (valid.httpStatus === 401 || valid.httpStatus === 403) return 'identity-rejected';
  // The gateway's clean auth denial: close 1008 "authentication_failed"
  // (the signature executor 65548050 produced on 2026-10-08).
  if (valid.opened && valid.closeCode === 1008) return 'identity-rejected';
  if (valid.opened && valid.closeCode === 1011 && !valid.stable) {
    if (!invalid) return 'inconclusive';
    if (sameFailureSignature(valid, invalid)) return 'hub-call-failure';
    return 'hub-session-open-failure';
  }
  return 'inconclusive';
}

export function fmtProbe(o: ProbeOutcome): string {
  if (!o.opened && o.httpStatus !== null) return `upgrade rejected (HTTP ${o.httpStatus})`;
  if (!o.opened) return `never opened${o.error ? `: ${o.error}` : ''}`;
  if (o.stable) return `open ≥ ${o.heldMs}ms (stable)`;
  const reason = o.closeReason ? ` ("${o.closeReason}")` : '';
  return `closed ${o.closeCode ?? '??'}${reason} after ${o.heldMs}ms`;
}

export function verdictDiagnosis(verdict: RepairVerdict, evidence: { valid: ProbeOutcome | null; invalid: ProbeOutcome | null }): string {
  switch (verdict) {
    case 'healthy':
      return 'Gateway reachable and the hub accepted this executor — the session held for the whole probe window. The executor ↔ gateway ↔ hub path is healthy; if the service still drops sessions, compare with `journalctl --user -u nexus-executor -n 50`.';
    case 'not-paired':
      return 'No gateway identity on this machine — the executor cannot connect because it was never enrolled (or the identity file was lost).';
    case 'direct-transport':
      return 'EXECUTOR_TRANSPORT is not "gateway" — the gateway/hub probes only apply to the gateway transport.';
    case 'misconfigured':
      return 'The gateway transport is configured incompletely — EXECUTOR_TRANSPORT=gateway also needs GATEWAY_URL.';
    case 'network-unreachable':
      return 'The gateway endpoint could not be reached at all — DNS, the local network, or Cloudflare. Nothing is wrong executor-side.';
    case 'route-missing':
      return 'The public chain answers, but /v1/enroll returns 404 — the Caddy ingress on the server is not routing the gateway host to nexus-gateway.';
    case 'gateway-origin-down':
      return 'The edge reaches the server, but the gateway origin errors (5xx) — nexus-gateway is down or Caddy cannot reach it.';
    case 'identity-rejected':
      return 'The hub rejected this executor\'s credential — the identity on this machine is stale, revoked, or mismatched. Re-pairing with a fresh identity is the fix.';
    case 'hub-call-failure':
      return `Both probes failed identically (${evidence.valid ? fmtProbe(evidence.valid) : 'n/a'}) — the gateway's hub call errors before/regardless of authentication: the hub is down, the gateway→hub link is broken, or the hub's gateway tables fail to read. Server-side problem; this executor's pairing is fine.`;
    case 'hub-session-open-failure':
      return 'The hub verified this executor\'s proof (garbage credentials are rejected cleanly) but the connect call then errors — the gateway closes with 1011 (hub_failure). The hub\'s session-open path is broken (e.g. the builder gateway tables / migration 020); this executor and its pairing are fine.';
    case 'inconclusive':
      return 'No known failure signature matched — capture the server-side evidence (runbook §4) and compare it against the decision table (§5).';
  }
}

export function verdictFixes(verdict: RepairVerdict, ctx: { gatewayUrl: string | null; identityPath: string | null }): string[] {
  const gateway = ctx.gatewayUrl ?? '<GATEWAY_URL>';
  switch (verdict) {
    case 'healthy':
      return ['Nothing to fix on this side — the chain is proven good.'];
    case 'not-paired':
      return [
        'Pair this executor — mint a code in the hub console (Builder → Executors → Pair executor), then:',
        `  nexus-executor pair --gateway ${gateway} --code <CODE>`,
        'Restart the service afterwards: systemctl --user restart nexus-executor',
      ];
    case 'direct-transport':
      return ['Set EXECUTOR_TRANSPORT=gateway (and GATEWAY_URL) in .env to use the gateway transport — see .env.example.'];
    case 'misconfigured':
      return ['Set GATEWAY_URL (https://…) in .env — see .env.example.'];
    case 'network-unreachable':
      return [
        'The endpoint is unreachable from this machine. Isolate it:',
        `  curl -v ${gateway}/v1/enroll`,
        'Check DNS, the local network, and Cloudflare status.',
      ];
    case 'route-missing':
      return [
        'On the server: fix the nexus-executor site block in the Caddyfile (it must proxy /v1/* to nexus-gateway) and reload Caddy.',
        'Hub-side operator docs: docs/nexus-executor-gateway-setup.md',
      ];
    case 'gateway-origin-down':
      return [
        'The edge reaches the server but the gateway origin errors. On the server:',
        '  systemctl status nexus-gateway   # then, if needed:',
        '  sudo systemctl restart nexus-gateway',
        'Also check cloudflared (the tunnel) and the gateway logs for crash loops.',
      ];
    case 'identity-rejected':
      return [
        'Re-pair with a FRESH identity — deleting the old one is mandatory, `pair` silently reuses it:',
        '  systemctl --user stop nexus-executor',
        `  rm -f ${ctx.identityPath ?? '<identity file>'} ~/.config/nexus-executor/state.json`,
        '  # mint a new code (Builder → Executors → Pair executor), then:',
        `  nexus-executor pair --gateway ${gateway} --code <CODE>`,
        '  systemctl --user start nexus-executor',
        `Procedure and pitfalls: ${REPAIR_RUNBOOK}`,
      ];
    case 'hub-call-failure':
      return [
        'Both probes fail identically — the gateway\'s hub call errors before/regardless of auth. On the server:',
        '  journalctl -u nexus-gateway --since "2 hours ago" --no-pager | tail -100',
        '  systemctl status nexus.service        # the hub itself',
        '  curl -s localhost:3999/health         # hub health (adjust to the deployment)',
        'Check the gateway→hub link and the hub database logs; the nonce discriminator in the runbook is the sharpest next step.',
        `Details: ${RUNBOOK} §4–5`,
      ];
    case 'hub-session-open-failure':
      return [
        'Auth passes; the hub errors opening the session (close 1011 / hub_failure). Most likely the builder gateway tables or migration 020 on the hub database. On the server:',
        '  journalctl -u nexus-gateway --since "2 hours ago" --no-pager | grep -iE "executor|hub_failure"',
        `  psql "$HUB_DATABASE_URL" -c "SELECT version FROM platform.schema_migrations WHERE module_id = 'builder' ORDER BY version;"`,
        '  # expect 020_executor_gateway.sql; if missing, back up the hub DB and run its npm run migrate',
        `Details: ${RUNBOOK} §4–5`,
      ];
    case 'inconclusive':
      return [`Capture the server-side evidence in ${RUNBOOK} §4 and compare against its decision table (§5).`];
  }
}

// ---------------------------------------------------------- static checks

function checkConfig(config: ExecutorConfig | null, configError: string | null): RepairCheck {
  const base = { id: 'config', section: 'static checks' as const, label: 'config' };
  if (configError) {
    return { ...base, status: 'fail', detail: configError, fix: 'Fix the environment (.env) — see .env.example; DATABASE_URL is required.' };
  }
  return {
    ...base,
    status: config!.transport === 'gateway' ? 'pass' : 'warn',
    detail: `transport=${config!.transport}, executor=${config!.executorName}`,
    fix: config!.transport === 'gateway' ? undefined : 'EXECUTOR_TRANSPORT=gateway enables the gateway probes',
  };
}

function checkIdentity(identityPath: string | null): { check: RepairCheck; identity: GatewayIdentity | null } {
  const base = { id: 'identity', section: 'static checks' as const, label: 'identity' };
  if (!identityPath) {
    return { check: { ...base, status: 'fail', detail: 'no identity path — not enrolled', fix: 'Run `nexus-executor pair`.' }, identity: null };
  }
  if (!existsSync(identityPath)) {
    return { check: { ...base, status: 'fail', detail: `${identityPath} is missing — not enrolled`, fix: 'Run `nexus-executor pair`.' }, identity: null };
  }
  const identity = readGatewayIdentity({ gatewayIdentityPath: identityPath });
  if (!identity) {
    return {
      check: {
        ...base, status: 'fail',
        detail: `${identityPath} is unreadable/malformed (expected version 1 with credential, executorId, keypair)`,
        fix: `Delete the file and re-pair — see ${REPAIR_RUNBOOK}.`,
      },
      identity: null,
    };
  }
  // Does the stored public key actually belong to the private key? (The
  // proof signs with the private key; the hub verifies against the public
  // key it stored at enrollment — a mismatch means re-pair.)
  let keyFail: string | null = null;
  try {
    const derived = createPublicKey(identity.privateKeyPem).export({ type: 'spki', format: 'pem' }) as string;
    if (derived.trim() !== identity.publicKeyPem.trim()) keyFail = 'stored public key does not match the private key';
  } catch {
    keyFail = 'keypair unreadable';
  }
  if (keyFail) {
    return {
      check: { ...base, status: 'fail', detail: `${identityPath}: ${keyFail}`, fix: `Delete the identity and re-pair — see ${REPAIR_RUNBOOK}.` },
      identity,
    };
  }
  const mode = statSync(identityPath).mode & 0o777;
  const modeNote = mode === 0o600 ? 'mode 0600' : `mode 0${mode.toString(8)} (should be 0600)`;
  const idNote = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.executorId)
    ? '' : ' (executorId looks unusual)';
  return {
    check: {
      ...base,
      status: mode === 0o600 ? 'pass' : 'warn',
      detail: `${identity.executorId.slice(0, 8)}… enrolled ${identity.enrolledAt}, ${modeNote}${idNote}`,
      fix: mode === 0o600 ? undefined : `chmod 600 ${identityPath}`,
    },
    identity,
  };
}

function checkCliState(
  state: ReturnType<typeof readCliState>,
  config: ExecutorConfig | null,
  identity: GatewayIdentity | null,
): RepairCheck {
  const base = { id: 'cli-state', section: 'static checks' as const, label: 'cli state' };
  if (!state) {
    return { ...base, status: 'fail', detail: 'no ~/.config/nexus-executor/state.json — never paired from this account', fix: 'Run `nexus-executor pair`.' };
  }
  if (state.transport !== 'gateway') {
    return { ...base, status: 'skip', detail: `transport ${state.transport} — gateway checks not applicable` };
  }
  const issues: string[] = [];
  if (!existsSync(state.identityPath)) issues.push(`state points at a missing identity (${state.identityPath})`);
  if (config && config.gatewayIdentityPath !== state.identityPath) {
    issues.push(`config resolves ${config.gatewayIdentityPath} but state points at ${state.identityPath} — the service and the CLI may use different identities`);
  }
  if (identity && state.enrolledAt !== identity.enrolledAt) {
    issues.push(`enrolledAt differs (state ${state.enrolledAt} vs identity ${identity.enrolledAt})`);
  }
  if (issues.length) {
    return { ...base, status: 'warn', detail: issues.join('; '), fix: 'Align GATEWAY_IDENTITY_PATH with the paired identity, or re-pair fresh.' };
  }
  return { ...base, status: 'pass', detail: `paired ${state.enrolledAt} (${state.name})` };
}

function checkClock(exec: typeof execFileSync): RepairCheck {
  const base = { id: 'clock', section: 'static checks' as const, label: 'clock (ntp)' };
  try {
    const value = String(exec('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { encoding: 'utf8' })).trim();
    if (value === 'yes') return { ...base, status: 'pass', detail: 'NTP synchronized' };
    return { ...base, status: 'warn', detail: 'NTP not synchronized — proofs allow ±120s; the gateway clock comparison below is the hard check', fix: 'sudo timedatectl set-ntp true' };
  } catch {
    return { ...base, status: 'skip', detail: 'timedatectl unavailable — skew is still checked against the gateway clock' };
  }
}

async function checkDatabase(config: ExecutorConfig | null, databaseCheck: NonNullable<RepairDeps['databaseCheck']>): Promise<RepairCheck> {
  const base = { id: 'database', section: 'static checks' as const, label: 'database' };
  if (!config) return { ...base, status: 'skip', detail: 'config unavailable' };
  const result = await databaseCheck(config.databaseUrl);
  return {
    ...base,
    status: result.ok ? 'pass' : 'fail',
    detail: result.detail,
    fix: result.ok ? undefined : 'systemctl --user start nexus-db (and check DATABASE_URL)',
  };
}

async function checkOpencode(config: ExecutorConfig | null, fetchImpl: typeof fetch): Promise<RepairCheck> {
  const base = { id: 'opencode', section: 'static checks' as const, label: 'opencode' };
  if (!config?.opencode.baseUrl) return { ...base, status: 'skip', detail: 'OPENCODE_BASE_URL not set' };
  try {
    const authorization = `Basic ${Buffer.from(`opencode:${config.opencode.token ?? ''}`).toString('base64')}`;
    const res = await fetchImpl(`${config.opencode.baseUrl}/api/info`, { headers: { authorization }, signal: AbortSignal.timeout(5000) });
    return { ...base, status: res.ok ? 'pass' : 'fail', detail: `GET /api/info → ${res.status}`, fix: res.ok ? undefined : 'systemctl --user start opencode-executor' };
  } catch (error) {
    return { ...base, status: 'fail', detail: error instanceof Error ? error.message : String(error), fix: 'systemctl --user start opencode-executor' };
  }
}

function checkServices(exec: typeof execFileSync): RepairCheck {
  const base = { id: 'services', section: 'static checks' as const, label: 'services' };
  if (process.platform !== 'linux') return { ...base, status: 'skip', detail: `not linux (${process.platform})` };
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`,
  };
  const states: Array<[string, string]> = [];
  for (const unit of SERVICE_UNITS) {
    try {
      states.push([unit, String(exec('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8', env })).trim()]);
    } catch (error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string' && stdout.trim()) states.push([unit, stdout.trim()]);
      else return { ...base, status: 'skip', detail: 'systemd user session unavailable (run repair from your login shell)' };
    }
  }
  const broken = states.filter(([, state]) => state !== 'active');
  return {
    ...base,
    status: broken.length ? 'fail' : 'pass',
    detail: states.map(([unit, state]) => `${unit}: ${state}`).join(', '),
    fix: broken.length ? `systemctl --user start ${broken.map(([unit]) => unit).join(' ')}` : undefined,
  };
}

async function checkDns(gatewayUrl: string, lookup: NonNullable<RepairDeps['lookup']>): Promise<RepairCheck> {
  const base = { id: 'dns', section: 'connectivity' as const, label: 'dns' };
  let host: string;
  try {
    host = new URL(gatewayUrl).hostname;
  } catch {
    return { ...base, status: 'fail', detail: `malformed GATEWAY_URL: ${gatewayUrl}`, fix: 'GATEWAY_URL must be a full https:// URL' };
  }
  try {
    const { address } = await lookup(host);
    return { ...base, status: 'pass', detail: `${host} → ${address}` };
  } catch (error) {
    return { ...base, status: 'fail', detail: error instanceof Error ? error.message : String(error), fix: 'Check DNS resolution and the local network.' };
  }
}

function checkRoute(route: RouteOutcome): RepairCheck {
  const base = { id: 'gateway-route', section: 'connectivity' as const, label: 'gateway route' };
  if (route.error) {
    return { ...base, status: 'fail', detail: route.error, fix: `Cannot reach the gateway — try: curl -v <GATEWAY_URL>/v1/enroll` };
  }
  if (route.status === 404) {
    return { ...base, status: 'fail', detail: 'HTTP 404 — the /v1/enroll route is missing (Caddy ingress misrouting)', fix: 'Fix the nexus-executor site block in the server\'s Caddyfile and reload Caddy.' };
  }
  if (route.status !== null && route.status >= 500) {
    return { ...base, status: 'fail', detail: `HTTP ${route.status} — the gateway origin is erroring/unreachable`, fix: 'On the server: systemctl restart nexus-gateway (check cloudflared too).' };
  }
  if (route.status !== null && route.status >= 400) {
    return { ...base, status: 'pass', detail: `HTTP ${route.status} (malformed body rejected — chain alive: CF → tunnel → Caddy → gateway)` };
  }
  return { ...base, status: 'warn', detail: `unexpected HTTP ${route.status}` };
}

function checkSkew(route: RouteOutcome): RepairCheck {
  const base = { id: 'clock-skew', section: 'connectivity' as const, label: 'clock skew' };
  if (route.dateSkewMs === null) return { ...base, status: 'skip', detail: 'no Date header from the gateway' };
  const skew = route.dateSkewMs;
  if (Math.abs(skew) > PROOF_WINDOW_MS) {
    return { ...base, status: 'fail', detail: `${skew > 0 ? '+' : ''}${Math.round(skew / 1000)}s vs the gateway clock — outside the ±120s proof window`, fix: 'Fix local time: sudo timedatectl set-ntp true' };
  }
  return { ...base, status: 'pass', detail: `${skew > 0 ? '+' : ''}${Math.round(skew / 1000)}s vs the gateway clock (window ±120s)` };
}

function invalidProbeCheck(valid: ProbeOutcome | null, invalid: ProbeOutcome | null): RepairCheck {
  const base = { id: 'connect-invalid', section: 'session probes' as const, label: 'connect invalid' };
  if (!invalid) return { ...base, status: 'skip', detail: 'not run' };
  if (invalid.stable) {
    return { ...base, status: 'fail', detail: 'GARBAGE CREDENTIAL ACCEPTED — the gateway/hub auth is broken server-side' };
  }
  if (!valid) return { ...base, status: 'warn', detail: fmtProbe(invalid) };
  if (valid.stable) {
    return { ...base, status: 'pass', detail: `${fmtProbe(invalid)} — bad credentials rejected as expected` };
  }
  if (sameFailureSignature(valid, invalid)) {
    return { ...base, status: 'fail', detail: `${fmtProbe(invalid)} — SAME failure as the valid probe: the hub call errors before/regardless of auth` };
  }
  return { ...base, status: 'pass', detail: `${fmtProbe(invalid)} — the auth layer rejects bad credentials cleanly (the valid proof gets further)` };
}

// ---------------------------------------------------------- orchestration

export interface RepairCliOptions {
  argv: string[];
  deps?: RepairDeps;
}

export async function repairFromCli(opts: RepairCliOptions): Promise<RepairResult> {
  const { values } = parseArgs({
    args: opts.argv,
    options: {
      json: { type: 'boolean', short: 'j' },
      'hold-ms': { type: 'string' },
    },
  });
  const holdMs = Math.max(500, Number.parseInt(String(values['hold-ms'] ?? '3000'), 10) || 3000);
  const deps: Required<RepairDeps> = {
    fetchImpl: fetch,
    webSocketImpl: WebSocket,
    lookup: dnsLookup,
    exec: execFileSync,
    databaseCheck: defaultDatabaseCheck,
    ...opts.deps,
  };

  const state = readCliState();
  let config: ExecutorConfig | null = null;
  let configError: string | null = null;
  try {
    config = loadConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  const checks: RepairCheck[] = [];
  checks.push(checkConfig(config, configError));
  const identityPath = state?.transport === 'gateway' ? state.identityPath : config?.gatewayIdentityPath ?? null;
  const { check: identityCheck, identity } = checkIdentity(identityPath);
  checks.push(identityCheck);
  checks.push(checkCliState(state, config, identity));
  checks.push(checkClock(deps.exec));
  checks.push(await checkDatabase(config, deps.databaseCheck));
  checks.push(await checkOpencode(config, deps.fetchImpl));
  checks.push(checkServices(deps.exec));

  const gatewayUrl = config?.gatewayUrl ?? ((state?.transport === 'gateway' ? state.gatewayUrl : null) ?? null);
  let route: RouteOutcome | null = null;
  if (gatewayUrl) {
    checks.push(await checkDns(gatewayUrl, deps.lookup));
    route = await probeRoute(gatewayUrl, deps.fetchImpl);
    checks.push(checkRoute(route));
    checks.push(checkSkew(route));
  }

  let valid: ProbeOutcome | null = null;
  let invalid: ProbeOutcome | null = null;
  if (gatewayUrl && identity) {
    const wsBase = gatewayUrl.replace(/^http/, 'ws');
    const probeOptions = { webSocketImpl: deps.webSocketImpl, holdMs, timeoutMs: holdMs + 12_000 };
    valid = await probeConnect(`${wsBase}/v1/connect`, buildConnectHeaders(identity), probeOptions);
    invalid = await probeConnect(`${wsBase}/v1/connect`, buildInvalidConnectHeaders(), probeOptions);
    checks.push({
      id: 'connect-valid', section: 'session probes', label: 'connect valid',
      status: valid.stable ? 'pass' : 'fail',
      detail: fmtProbe(valid),
    });
    checks.push(invalidProbeCheck(valid, invalid));
  }

  const transport = config?.transport ?? state?.transport ?? null;
  const verdict = classifyRepair({ transport, hasIdentity: identity !== null, gatewayUrl, route, valid, invalid });
  const diagnosis = verdictDiagnosis(verdict, { valid, invalid });
  const fixes = [
    ...verdictFixes(verdict, { gatewayUrl, identityPath }),
    ...checks.filter((c) => c.status === 'fail' && c.fix).map((c) => c.fix!),
  ].filter((fix, index, all) => all.indexOf(fix) === index);
  const ok = verdict === 'healthy' && !checks.some((c) => c.status === 'fail');

  const report: RepairReport = {
    version: EXECUTOR_VERSION,
    gatewayUrl,
    executorId: identity?.executorId ?? null,
    transport,
    checks,
    route,
    probes: { valid, invalid },
    verdict,
    diagnosis,
    fixes,
    ok,
  };
  const text = values.json ? JSON.stringify(report, null, 2) : renderText(report);
  return { text, ok, report };
}

// ---------------------------------------------------------------- output

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function renderText(report: RepairReport): string {
  const lines: string[] = [];
  lines.push(`nexus-executor repair v${report.version}`);
  lines.push(`gateway ${report.gatewayUrl ?? '(unset)'} · executor ${report.executorId ?? '(unpaired)'} · transport ${report.transport ?? '?'}`);
  lines.push('');
  let section = '';
  for (const check of report.checks) {
    if (check.section !== section) {
      section = check.section;
      lines.push(section);
    }
    const marker = check.status.toUpperCase().padEnd(4);
    lines.push(`  ${marker}  ${check.label.padEnd(15)} ${check.detail}`);
  }
  lines.push('');
  lines.push(`diagnosis: ${report.verdict}`);
  for (const line of wrap(report.diagnosis, 86)) lines.push(`  ${line}`);
  if (report.fixes.length) {
    lines.push('');
    lines.push('suggested fixes:');
    report.fixes.forEach((fix, index) => lines.push(`  ${index + 1}. ${fix}`));
  }
  lines.push('');
  return lines.join('\n');
}

/** The real database check: connect + SELECT 1 with a short timeout. */
async function defaultDatabaseCheck(databaseUrl: string): Promise<{ ok: boolean; detail: string }> {
  let client: Client | null = null;
  try {
    const started = Date.now();
    client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
    await client.connect();
    await client.query('SELECT 1');
    let target = databaseUrl;
    try {
      const url = new URL(databaseUrl);
      target = `${url.hostname}:${url.port || '5432'}${url.pathname}`;
    } catch { /* keep the raw string */ }
    return { ok: true, detail: `SELECT 1 ok in ${Date.now() - started}ms (${target})` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.end().catch(() => undefined);
  }
}
