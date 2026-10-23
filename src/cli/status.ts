import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { EXECUTOR_VERSION, loadConfig } from '../config.js';
import { readCliState } from '../pairing/state.js';

/**
 * `nexus-executor status` — one screen answering "is my executor healthy?":
 * pairing, the service unit, the gateway session (WITH the last close/error
 * when it is not connected), and running/queued jobs. `--json` emits a
 * machine-readable object.
 *
 * The runtime sections are best-effort and PASSIVE by design:
 *   - service state comes from `systemctl --user show nexus-executor`;
 *   - connection state is reconstructed from the service's own pino JSON in
 *     the journal (the loop logs every `gateway WebSocket opened` and every
 *     `gateway session lost; reconnecting` with closeCode/reason/error) —
 *     this never dials the gateway. (A diagnostic connect would take over
 *     the hub's single session lease for this executor and can leave the
 *     service with a socket the hub no longer honors: use
 *     `nexus-executor repair` deliberately, never from monitoring.)
 *   - jobs come from executor.jobs in the local database.
 * Anything unavailable degrades to a short "unknown/unavailable (reason)"
 * note instead of throwing — `status` doubles as the bare-command summary.
 */

export interface StatusCliOptions {
  argv: string[];
  deps?: StatusDeps;
}

export interface StatusDeps {
  exec?: typeof execFileSync;
  jobsCheck?: (databaseUrl: string) => Promise<JobsSnapshot>;
}

export interface JobsRow {
  id: string;
  status: string;
  title: string;
  createdAt: string | null;
  startedAt: string | null;
}

export interface JobsSnapshot {
  counts: Record<string, number>;
  active: JobsRow[];
  error?: string;
}

export interface ServiceStatus {
  state: string | null;
  pid: number | null;
  startedAt: string | null;
  error?: string;
}

export interface ConnectionStatus {
  /** connected = the last session event was an open; reconnecting = a loss
   *  (the loop retries forever); down = the service logged its shutdown;
   *  unknown = no session events in the log. */
  state: 'connected' | 'reconnecting' | 'down' | 'unknown';
  since: string | null;
  upSeconds: number | null;
  lastClose: {
    at: string;
    code: number | null;
    reason: string;
    sessionMs: number | null;
    error: string | null;
  } | null;
  detail: string;
}

export interface StatusReport {
  transport: 'gateway' | 'direct' | null;
  name: string | null;
  version: string;
  paired: boolean;
  enrolled?: boolean;
  gatewayOk?: boolean;
  gatewayUrl?: string | null;
  hubUrl?: string | null;
  identityPath?: string | null;
  pairedAt?: string | null;
  message?: string;
  service?: ServiceStatus;
  connection?: ConnectionStatus;
  jobs?: JobsSnapshot;
}

export async function statusFromCli(opts: StatusCliOptions): Promise<string> {
  const { values } = parseArgs({ args: opts.argv, options: { json: { type: 'boolean', short: 'j' } } });
  const deps: Required<StatusDeps> = {
    exec: execFileSync,
    jobsCheck: defaultJobsCheck,
    ...opts.deps,
  };
  const state = readCliState();
  const now = Date.now();

  const base = {
    transport: state?.transport ?? null,
    name: state?.name ?? null,
    version: EXECUTOR_VERSION,
    service: readServiceStatus(deps.exec),
    connection: readConnection(deps.exec, now),
    jobs: await readJobs(deps.jobsCheck),
  };

  if (!state) {
    const report: StatusReport = { ...base, paired: false, message: 'not paired' };
    return values.json
      ? JSON.stringify(report)
      : [`nexus-executor v${EXECUTOR_VERSION} — not paired (run \`nexus-executor pair\`)`, ...runtimeRows(report)].join('\n');
  }

  if (state.transport === 'gateway') {
    const hasIdentity = state.identityPath ? existsSync(state.identityPath) : false;
    const report: StatusReport = {
      ...base,
      paired: true,
      enrolled: hasIdentity,
      gatewayOk: base.connection.state === 'connected',
      gatewayUrl: state.gatewayUrl,
      identityPath: state.identityPath,
      pairedAt: state.enrolledAt,
    };
    return values.json ? JSON.stringify(report) : statusText(report);
  }

  const report: StatusReport = {
    ...base,
    paired: true,
    hubUrl: state.hubUrl,
    pairedAt: state.pairedAt,
  };
  return values.json ? JSON.stringify(report) : statusText(report);
}

// ---------------------------------------------------------------- runtime

const ACTIVE_JOB_STATUSES = ['created', 'queued', 'running', 'waiting_for_user', 'verifying'] as const;

function execEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`,
  };
}

function readServiceStatus(exec: typeof execFileSync): ServiceStatus {
  if (process.platform !== 'linux') return { state: null, pid: null, startedAt: null, error: `not linux (${process.platform})` };
  try {
    const out = String(exec(
      'systemctl',
      ['--user', 'show', 'nexus-executor', '-p', 'ActiveState', '-p', 'ExecMainPID', '-p', 'ActiveEnterTimestamp'],
      { encoding: 'utf8', env: execEnv() },
    ));
    const props: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    return {
      state: props.ActiveState ?? null,
      pid: props.ExecMainPID ? Number.parseInt(props.ExecMainPID, 10) || null : null,
      startedAt: props.ActiveEnterTimestamp ?? null,
    };
  } catch {
    return { state: null, pid: null, startedAt: null, error: 'systemd user session unavailable' };
  }
}

function readConnection(exec: typeof execFileSync, now: number): ConnectionStatus {
  const none: ConnectionStatus = { state: 'unknown', since: null, upSeconds: null, lastClose: null, detail: '' };
  let raw: string;
  try {
    // -o cat prints just the unit's own log lines — the service logs pino
    // JSON there, which is what we parse below.
    raw = String(exec('journalctl', ['--user', '-u', 'nexus-executor', '-n', '200', '--no-pager', '-o', 'cat'], { encoding: 'utf8', env: execEnv() }));
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    raw = typeof stdout === 'string' ? stdout : '';
    if (!raw.trim()) return { ...none, detail: 'service log unavailable (journalctl failed)' };
  }
  const events: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch { /* journald/systemd prose lines are not pino JSON */ }
  }
  // Newest first: the last session event decides the state.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const time = typeof e.time === 'number' ? e.time : null;
    if (e.msg === 'gateway WebSocket opened; awaiting gateway requests' && time !== null) {
      const upSeconds = Math.max(0, Math.round((now - time) / 1000));
      return {
        state: 'connected',
        since: new Date(time).toISOString(),
        upSeconds,
        lastClose: null,
        detail: `connected since ${fmtTime(time)} (up ${fmtDur(upSeconds)})`,
      };
    }
    if (e.msg === 'gateway session lost; reconnecting' && time !== null) {
      const code = typeof e.closeCode === 'number' ? e.closeCode : null;
      const reason = typeof e.closeReason === 'string' ? e.closeReason : '';
      const sessionMs = typeof e.sessionDurationMs === 'number' ? e.sessionDurationMs : null;
      const error = typeof e.error === 'string' && e.error ? e.error : null;
      const parts = [`reconnecting`, `last session lost after ${sessionMs ?? '?'}ms`, `close ${code ?? '?'}${reason ? ` ${JSON.stringify(reason)}` : ''}`];
      if (error) parts.push(`error: ${error}`);
      return {
        state: 'reconnecting',
        since: null,
        upSeconds: null,
        lastClose: { at: new Date(time).toISOString(), code, reason, sessionMs, error },
        detail: `${parts.join(' — ')} at ${fmtTime(time)}`,
      };
    }
    if (e.msg === 'shutting down' && time !== null) {
      return {
        state: 'down',
        since: null,
        upSeconds: null,
        lastClose: null,
        detail: `down — service logged "shutting down" at ${fmtTime(time)}`,
      };
    }
  }
  return { ...none, detail: 'no gateway session events in the service log' };
}

async function readJobs(jobsCheck: StatusDeps['jobsCheck']): Promise<JobsSnapshot> {
  try {
    const config = loadConfig();
    return await jobsCheck!(config.databaseUrl);
  } catch (error) {
    return { counts: {}, active: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** The real jobs check: status counts + the active/queued tail of executor.jobs. */
export async function defaultJobsCheck(databaseUrl: string): Promise<JobsSnapshot> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const counts: Record<string, number> = {};
    const grouped = await client.query('SELECT status, COUNT(*)::int AS n FROM executor.jobs GROUP BY status');
    for (const row of grouped.rows as Array<{ status: string; n: number }>) counts[row.status] = row.n;
    const listed = await client.query(
      `SELECT id, status, title, created_at, started_at FROM executor.jobs
        WHERE status IN (${ACTIVE_JOB_STATUSES.map((_, i) => `$${i + 1}`).join(',')})
        ORDER BY created_at ASC LIMIT 20`,
      [...ACTIVE_JOB_STATUSES],
    );
    const active = (listed.rows as Array<{ id: string; status: string; title: string; created_at: Date | null; started_at: Date | null }>).map((row) => ({
      id: String(row.id),
      status: row.status,
      title: row.title,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    }));
    return { counts, active };
  } catch (error) {
    return { counts: {}, active: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ----------------------------------------------------------------- render

function statusText(r: StatusReport): string {
  return [
    `Executor:  ${r.name ?? '—'}`,
    `Transport: ${r.transport ?? '—'}`,
    `Version:   ${r.version ?? '—'}`,
    r.enrolled === false ? 'Enrolled:  no (identity file missing — run nexus-executor pair)' : `Enrolled:  yes`,
    r.gatewayUrl ? `Gateway:   ${r.gatewayUrl}` : '',
    r.hubUrl ? `Hub:       ${r.hubUrl}` : '',
    r.pairedAt ? `Paired:    ${r.pairedAt}` : '',
    ...runtimeRows(r),
  ].filter(Boolean).join('\n');
}

function runtimeRows(r: StatusReport): string[] {
  const rows: string[] = [];
  if (r.service) rows.push(row('Service', serviceText(r.service)));
  if (r.connection) rows.push(row('Connection', r.connection.detail));
  if (r.jobs) rows.push(row('Jobs', jobsText(r.jobs)));
  for (const j of r.jobs?.active ?? []) {
    const when = j.startedAt ? `since ${fmtTime(Date.parse(j.startedAt))}` : `queued ${fmtTime(Date.parse(j.createdAt ?? ''))}`;
    rows.push(`  ${j.id.slice(0, 8)}  ${j.status.padEnd(15)} ${truncate(j.title || '—', 42).padEnd(44)}${when}`);
  }
  return rows;
}

function serviceText(s: ServiceStatus): string {
  if (s.error) return `unknown (${s.error})`;
  const bits: string[] = [];
  if (s.pid) bits.push(`pid ${s.pid}`);
  if (s.startedAt) bits.push(`since ${s.startedAt}`);
  return bits.length ? `${s.state ?? 'unknown'} (${bits.join(', ')})` : (s.state ?? 'unknown');
}

function jobsText(j: JobsSnapshot): string {
  if (j.error) return `unavailable (${j.error.split('\n')[0]})`;
  const total = Object.values(j.counts).reduce((a, b) => a + b, 0);
  if (!total) return 'none recorded';
  const parts = (['running', 'verifying', 'waiting_for_user', 'created', 'queued', 'failed', 'succeeded', 'cancelled'] as const)
    .filter((s) => j.counts[s])
    .map((s) => `${j.counts[s]} ${s}`);
  return `${parts.join(', ')} (${total} total)`;
}

function row(label: string, value: string): string {
  return `${`${label}:`.padEnd(12)}${value}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
