import Fastify from 'fastify';
import pino from 'pino';
import { createAuthHook, readAuthConfig } from './auth.js';
import { loadConfig } from './config.js';
import { createPool, defaultMigrationsDir, runModuleMigrations } from './db.js';
import { JobEngine } from './engine.js';
import { createOpenCodeClient } from './opencode.js';
import { claimPairing } from './pairing.js';
import { registerRoutes } from './routes.js';
import { startWorker } from './worker.js';

/**
 * Boot: config → pool → migrations → (one-shot pairing when PAIR_CODE is
 * set and no auth row exists) → Fastify + routes → poll worker → listen.
 * `npm run migrate` runs `src/main.ts --migrate-only`: apply and exit.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const pool = createPool(config.databaseUrl);
  const startedAt = Date.now();

  const ran = await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
  if (ran.length) logger.info({ migrations: ran }, 'migrations applied');

  if (process.argv.includes('--migrate-only')) {
    logger.info('migrate-only: done');
    await pool.end();
    return;
  }

  if (config.transport === 'gateway') {
    // Outbound-only transport: no HTTP listener, no pair token — enroll
    // with the pairing code ONCE (persisted identity), then serve the
    // canonical operations over the dialed-out WebSocket.
    const { enrollGateway, runGatewayLoop } = await import('./gateway.js');
    const identity = await enrollGateway(config);
    logger.info({ executorId: identity.executorId }, 'enrolled with gateway');

    const client = config.opencode.baseUrl
      ? createOpenCodeClient({
        baseUrl: config.opencode.baseUrl,
        token: config.opencode.token,
        agent: config.opencode.agent,
      })
      : null;
    if (!client) {
      logger.warn('OPENCODE_BASE_URL is unset — jobs will queue but never launch');
    }
    const onError = (error: unknown): void => {
      logger.warn({ err: error }, 'worker error');
    };
    const engine = new JobEngine({ pool, config, client, onError });
    const stopWorker = startWorker(engine, { onError });

    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      logger.info({ signal }, 'shutting down');
      await stopWorker();
      await pool.end().catch(() => {});
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));

    // Runs until a signal flips closing; reconnects internally forever.
    await runGatewayLoop({ pool, config, engine, client, startedAt }, config, {
      logger, isStopped: () => closing,
    });
    return;
  }

  if (config.pairCode && !(await readAuthConfig(pool))) {
    const outcome = await claimPairing(config, pool);
    logger.info({ id: outcome.id, hubUrl: outcome.hubUrl }, `paired with hub as ${outcome.name}${outcome.id ? ` (id ${outcome.id})` : ''}`);
  }

  const client = config.opencode.baseUrl
    ? createOpenCodeClient({
      baseUrl: config.opencode.baseUrl,
      token: config.opencode.token,
      agent: config.opencode.agent,
    })
    : null;
  if (!client) {
    logger.warn('OPENCODE_BASE_URL is unset — jobs will queue but never launch');
  }

  const app = Fastify({ logger: false });
  app.addHook('preHandler', createAuthHook(pool));

  const onError = (error: unknown): void => {
    logger.warn({ err: error }, 'worker error');
  };
  const engine = new JobEngine({ pool, config, client, onError });
  registerRoutes(app, { pool, config, engine, client, startedAt });
  const stopWorker = startWorker(engine, { onError });

  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, host: config.host, name: config.executorName }, 'executor listening');

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      await stopWorker();
      await pool.end().catch(() => {});
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
