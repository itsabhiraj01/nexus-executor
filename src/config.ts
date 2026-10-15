import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { resolveUpgradeCommand } from './upgrade.js';

/**
 * Every runtime knob the executor reads, parsed from the environment in one
 * place. `.env.example` documents each variable; keep the two in sync.
 */

/** The executor's version, SINGLE-SOURCED from package.json (resolves from
 *  both `src/` under tsx and `dist/` compiled): the hub reads the same file
 *  on its side to compute "latest", so there must never be a second,
 *  hand-maintained copy to drift (the 0.3.0/0.4.0 split). */
function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
  } catch { /* unreadable packaging — the fallback still reports honestly */ }
  return '0.0.0';
}

// Lineage note: THIS repository is the single executor lineage — the monorepo's
// executor/ directory is a restored-from-history snapshot used for hub-side
// development (see docs/remote-executors.md), and the 0.3.x/0.4.x/0.5.0
// divergence between the two lineages was unified into this repo at 1.0.0
// (status item 165's deferred reconciliation, completed).
export const EXECUTOR_VERSION = readPackageVersion();

export interface ExecutorConfig {
  /** Connection string of this executor's own Postgres database. */
  databaseUrl: string;
  port: number;
  host: string;
  logLevel: string;
  /** Display name shown on the hub next to jobs. */
  executorName: string;
  /** The URL the hub dials back (pairing advertises it). */
  publicUrl: string | null;
  /** Hub base URL used by the one-shot pairing call. */
  hubUrl: string | null;
  /** One-shot pairing code, consumed at boot when unpaired. */
  pairCode: string | null;
  opencode: {
    baseUrl: string | null;
    token: string | null;
    agent: string | null;
  };
  /** Repos (clones) + per-job worktrees live under here. */
  workspaceRoot: string;
  /** Branch to merge into; null = the repo's own default branch. */
  baseRef: string | null;
  /** Command run in the repo after a merge; null = no deploy. */
  deployCommand: string | null;
  maxParallelJobs: number;
  pollIntervalMs: number;
  /** A tool call running this long counts as stalled (0 disables). */
  toolStallMs: number;
  /** An in-flight turn silent this long counts as stalled (0 disables). */
  silenceStallMs: number;
  /** A tool with unchanged output for this long fails the job (0 disables). */
  toolProgressMs: number;
  /** Started jobs fail after this long (0 disables; waiting_for_user exempt). */
  jobTimeoutMs: number;
  /** Days a terminal job's workspace (worktree + branch) is kept before the
   *  retention sweep removes it (0 = keep forever, sweep off). */
  workspaceRetentionDays: number;
  /** Total attempts one job gets when its spec carries no retry ask
   *  (1 = fail on the first error — retries off). */
  retryMaxAttempts: number;
  /** Minutes between a retryable failure and the requeued attempt's launch. */
  retryDelayMinutes: number;
  /** How the hub reaches this executor: 'direct' = it dials our HTTP
   *  listener; 'gateway' = we dial OUT to the nexus-gateway service
   *  (Cloudflare Tunnel) and serve over that WebSocket. */
  transport: 'direct' | 'gateway';
  /** Public gateway base URL (https://…; gateway transport). */
  gatewayUrl: string | null;
  /** Ed25519 identity + credential store (gateway transport). */
  gatewayIdentityPath: string;
  /** The verbatim command hub-triggered upgrades run when set (takes
   *  precedence over the shipped script — the rsync/copy/docker escape
   *  hatch). null = probe the repo layout (below). */
  upgradeCommand: string | null;
  /** This machine's own git checkout of this repository — hub-triggered
   *  upgrades run the shipped self-upgrade.sh against it (fetch → reset →
   *  rebuild → restart). null = hub-triggered upgrades refuse. */
  upgradeRepoDir: string | null;
  /** The ref self-upgrade.sh resets the checkout onto. */
  upgradeRef: string;
  /** The systemd unit self-upgrade.sh restarts. */
  upgradeServiceName: string;
  /** When the service runs from somewhere else (a persistent install the
   *  reset can't clobber), self-upgrade.sh rsyncs the rebuilt tree here
   *  (persistent state — .env, data/ — survives). */
  upgradeInstallDir: string | null;
}

/** The feature contract this executor speaks, advertised in /api/v1/status
 *  and at pairing. The hub gates its own cross-run auto-retry on
 *  `jobRetries` (an executor that retries in-job must never also be
 *  retried by the hub: budgets would multiply); `modelPolicy` unlocks
 *  hub-side model fencing; `selfUpgrade` unlocks the Restart-to-update
 *  console action. */
export function executorCapabilities(config: Pick<ExecutorConfig, 'upgradeCommand' | 'upgradeRepoDir'>): Record<string, unknown> {
  return {
    jobRetries: true,
    modelFallback: true,
    projectRegistry: true,
    discovery: true,
    terminals: true,
    terminalSync: true,
    modelPolicy: true,
    // NOTE: `nativeAgents` (worktree persona materialization) is intentionally
    // NOT advertised until the engine reconcile (Task 2.8) ports the
    // monorepo's agent-materialization code path — advertising it first would
    // make the hub send personas this engine can't honor.
    ...(resolveUpgradeCommand(config) ? { selfUpgrade: true } : {}),
  };
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required (see .env.example)`);
  return value;
}

function optional(name: string, env: NodeJS.ProcessEnv): string | null {
  return env[name]?.trim() || null;
}

function integer(name: string, env: NodeJS.ProcessEnv, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer ≥ ${min}, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Minutes → ms; 0 disables the check entirely. */
function minutes(name: string, env: NodeJS.ProcessEnv, fallback: number): number {
  return integer(name, env, fallback) * 60_000;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  return {
    databaseUrl: required('DATABASE_URL', env),
    port: integer('PORT', env, 4099, 1),
    host: env.HOST?.trim() || '0.0.0.0',
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    executorName: env.EXECUTOR_NAME?.trim() || hostname(),
    publicUrl: optional('EXECUTOR_PUBLIC_URL', env)?.replace(/\/+$/, '') ?? null,
    hubUrl: optional('HUB_URL', env)?.replace(/\/+$/, '') ?? null,
    pairCode: optional('PAIR_CODE', env),
    opencode: {
      baseUrl: optional('OPENCODE_BASE_URL', env)?.replace(/\/+$/, '') ?? null,
      token: optional('OPENCODE_TOKEN', env),
      agent: optional('OPENCODE_AGENT', env) ?? 'build',
    },
    workspaceRoot: resolve(env.EXECUTOR_WORKSPACE_ROOT?.trim() || resolve(process.cwd(), 'data', 'workspaces')),
    baseRef: optional('EXECUTOR_BASE_REF', env),
    deployCommand: optional('EXECUTOR_DEPLOY_COMMAND', env),
    maxParallelJobs: Math.max(1, integer('EXECUTOR_MAX_PARALLEL_JOBS', env, 1, 1)),
    pollIntervalMs: Math.max(250, integer('EXECUTOR_POLL_INTERVAL_MS', env, 2000, 250)),
    toolStallMs: minutes('EXECUTOR_TOOL_STALL_MINUTES', env, 50),
    silenceStallMs: minutes('EXECUTOR_STALL_MINUTES', env, 20),
    toolProgressMs: minutes('EXECUTOR_TOOL_PROGRESS_MINUTES', env, 10),
    jobTimeoutMs: minutes('EXECUTOR_JOB_TIMEOUT_MINUTES', env, 120),
    workspaceRetentionDays: integer('EXECUTOR_WORKSPACE_RETENTION_DAYS', env, 7),
    retryMaxAttempts: Math.min(10, Math.max(1, integer('EXECUTOR_RETRY_MAX', env, 3, 1))),
    retryDelayMinutes: Math.min(60, integer('EXECUTOR_RETRY_DELAY_MINUTES', env, 2)),
    transport: env.EXECUTOR_TRANSPORT?.trim() === 'gateway' ? 'gateway' : 'direct',
    gatewayUrl: optional('GATEWAY_URL', env)?.replace(/\/+$/, '') ?? null,
    gatewayIdentityPath: optional('GATEWAY_IDENTITY_PATH', env)
      ?? resolve(env.EXECUTOR_WORKSPACE_ROOT?.trim() || resolve(process.cwd(), 'data', 'workspaces'), '..', 'gateway-identity.json'),
    upgradeCommand: optional('EXECUTOR_UPGRADE_COMMAND', env),
    upgradeRepoDir: optional('EXECUTOR_REPO_DIR', env),
    upgradeRef: env.EXECUTOR_UPGRADE_REF?.trim() || 'main',
    upgradeServiceName: env.EXECUTOR_SERVICE_NAME?.trim() || 'nexus-executor',
    upgradeInstallDir: optional('EXECUTOR_INSTALL_DIR', env),
  };
}
