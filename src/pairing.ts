import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { hashToken, readAuthConfig, writeAuthConfig } from './auth.js';
import { EXECUTOR_VERSION, executorCapabilities, loadConfig, type ExecutorConfig } from './config.js';
import { createPool } from './db.js';
import type { Pool } from 'pg';

/**
 * One-shot pairing with the hub. The executor POSTs its pair code to
 * `${HUB_URL}/api/executors/pair`; on success the hub returns a bearer
 * token — used for every later hub→executor call. The executor stores ONLY
 * the token's SHA-256 hex digest (see auth.ts): a leaked executor database
 * cannot impersonate the hub.
 *
 * Used by `npm run pair` AND at boot when `PAIR_CODE` is set and the
 * executor is not yet paired. Running again once paired is a no-op.
 */

export interface PairingOutcome {
  alreadyPaired: boolean;
  id?: string;
  name?: string;
  hubUrl?: string;
}

export class PairingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export async function claimPairing(
  config: ExecutorConfig,
  pool: Pool,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PairingOutcome> {
  const existing = await readAuthConfig(pool);
  if (existing) {
    return { alreadyPaired: true, name: existing.name, hubUrl: existing.hubUrl };
  }
  if (!config.hubUrl) throw new PairingError('HUB_URL is required for pairing.');
  if (!config.pairCode) throw new PairingError('PAIR_CODE is required for pairing.');
  if (!config.publicUrl) throw new PairingError('EXECUTOR_PUBLIC_URL is required for pairing (the address the hub dials back).');

  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${config.hubUrl}/api/executors/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: config.pairCode,
        name: config.executorName,
        url: config.publicUrl,
        version: EXECUTOR_VERSION,
        capabilities: executorCapabilities(),
      }),
    });
  } catch (cause) {
    throw new PairingError(`Pairing request to ${config.hubUrl} failed: ${String(cause)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new PairingError(`Pairing failed: ${res.status} ${body.slice(0, 400)}`, res.status);
  }
  // The hub answers { executorId, name, token } (older builds answered the
  // same fields with `id` instead of `executorId` — accept both).
  const body = await res.json().catch(() => null) as { executorId?: unknown; id?: unknown; token?: unknown; name?: unknown } | null;
  if (!body || typeof body.token !== 'string' || !body.token) {
    throw new PairingError('Pairing failed: the hub response carried no token.');
  }
  const name = typeof body.name === 'string' && body.name ? body.name : config.executorName;
  await writeAuthConfig(pool, {
    tokenHash: hashToken(body.token),
    hubUrl: config.hubUrl,
    name,
    pairedAt: new Date().toISOString(),
  });
  return {
    alreadyPaired: false,
    id: typeof body.executorId === 'string' ? body.executorId
      : typeof body.id === 'string' ? body.id : undefined,
    name,
    hubUrl: config.hubUrl,
  };
}

/** `npm run pair` — the CLI entry (tsx --env-file=.env src/pairing.ts). */
async function cli(): Promise<void> {
  const logger = pino({ level: process.env.LOG_LEVEL?.trim() || 'info' });
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    if (config.transport === 'gateway') {
      // Gateway transport: enrollment exchanges the pairing code through the
      // gateway and persists the device identity (no bearer token at all).
      const { enrollGateway, readGatewayIdentity } = await import('./gateway.js');
      if (readGatewayIdentity(config)) {
        logger.info('Already enrolled with the gateway — nothing to do (delete the identity file to re-enroll).');
        return;
      }
      const identity = await enrollGateway(config);
      logger.info({ executorId: identity.executorId }, 'Enrolled with the gateway.');
      return;
    }
    const outcome = await claimPairing(config, pool);
    if (outcome.alreadyPaired) {
      logger.info({ hubUrl: outcome.hubUrl }, `Already paired as "${outcome.name}" — nothing to do.`);
      return;
    }
    logger.info({ id: outcome.id, hubUrl: outcome.hubUrl }, `Paired with the hub as "${outcome.name}".`);
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  cli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
