import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  healthPaired, jobSummary, MAX_MESSAGE_CHARS,
  opConfigPut, opCreateJob, opJobCancel, opJobEvents, opJobLog, opJobMerge,
  opJobMessage, opJobVerify, opModels, opShowJob, opStatus,
  type OpResult, type RouteDeps,
} from './ops.js';
import { rowToJob } from './engine.js';
import { RateLimiter } from './rate-limit.js';

/**
 * The executor's HTTP contract (direct transport). Handlers are thin
 * adapters over `ops.ts` — the same functions the gateway WebSocket
 * transport dispatches — so responses and error shapes (`{error: string}`
 * with fitting 4xx/5xx) stay verbatim regardless of how the hub reached us.
 * Base `/api/v1`; `/health` is public.
 */

const JOB_STATUSES = ['created', 'queued', 'running', 'waiting_for_user', 'verifying', 'failed', 'succeeded', 'cancelled'] as const;

export type { RouteDeps } from './ops.js';
export { validateJobBody } from './ops.js';

function send(reply: FastifyReply, result: OpResult): void {
  void reply.code(result.status).send(result.body);
}

/* ── Routes ────────────────────────────────────────────────────────────── */

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool, config } = deps;
  const jobCreateLimiter = new RateLimiter({ max: 30, windowMs: 60_000 });
  const actionLimiter = new RateLimiter({ max: 120, windowMs: 60_000 });

  const limit = (limiter: RateLimiter) => async (request: { ip: string }, reply: FastifyReply) => {
    const hit = limiter.hit(request.ip || 'unknown');
    if (!hit.allowed) {
      await reply.code(429).send({ error: `Rate limit exceeded — retry in ${hit.retryAfterSeconds}s.` });
    }
  };

  app.get('/health', async (_request, reply) => {
    const health = await healthPaired(deps);
    return reply.code(health.ok ? 200 : 503).send({ ...health, name: config.executorName });
  });

  app.get('/api/v1/status', async (_request, reply) => {
    send(reply, await opStatus(deps));
  });

  app.get<{ Querystring: { directory?: string } }>('/api/v1/models', async (request, reply) => {
    send(reply, await opModels(deps, request.query.directory));
  });

  app.post('/api/v1/jobs', { bodyLimit: 40 * 1024 * 1024, preHandler: limit(jobCreateLimiter) }, async (request, reply) => {
    send(reply, await opCreateJob(deps, request.body));
  });

  app.get<{ Querystring: { status?: string; limit?: string; updatedSince?: string } }>('/api/v1/jobs', async (request, reply) => {
    const status = request.query.status?.trim();
    if (status && !(JOB_STATUSES as readonly string[]).includes(status)) {
      void reply.code(400).send({ error: `Unknown status filter "${status}".` });
      return;
    }
    let limit = Number.parseInt(request.query.limit ?? '100', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    limit = Math.min(limit, 500);
    let updatedSince: Date | null = null;
    if (request.query.updatedSince?.trim()) {
      updatedSince = new Date(request.query.updatedSince.trim());
      if (Number.isNaN(updatedSince.getTime())) {
        void reply.code(400).send({ error: `updatedSince is not a valid ISO timestamp: ${request.query.updatedSince}` });
        return;
      }
    }
    const { rows } = await pool.query<Parameters<typeof rowToJob>[0]>(`
      SELECT * FROM executor.jobs
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::timestamptz IS NULL OR updated_at > $2)
      ORDER BY updated_at ASC
      LIMIT $3`, [status ?? null, updatedSince, limit]);
    return { jobs: rows.map((row) => jobSummary(rowToJob(row))) };
  });

  app.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId', async (request, reply) => {
    send(reply, await opShowJob(deps, request.params.jobId));
  });

  app.get<{ Params: { jobId: string }; Querystring: { sinceSeq?: string; limit?: string } }>(
    '/api/v1/jobs/:jobId/events', async (request, reply) => {
      const sinceSeq = Number.parseInt(request.query.sinceSeq ?? '0', 10);
      if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
        void reply.code(400).send({ error: 'sinceSeq must be a non-negative integer.' });
        return;
      }
      let limit = Number.parseInt(request.query.limit ?? '200', 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 200;
      limit = Math.min(limit, 500);
      send(reply, await opJobEvents(deps, request.params.jobId, sinceSeq, limit));
    });

  app.post<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/message', { preHandler: limit(actionLimiter) }, async (request, reply) => {
      const text = (request.body as { text?: unknown } | undefined)?.text;
      if (typeof text !== 'string' || !text.trim()) {
        void reply.code(400).send({ error: 'text is required.' });
        return;
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        void reply.code(400).send({ error: `text must be ≤ ${MAX_MESSAGE_CHARS} chars.` });
        return;
      }
      send(reply, await opJobMessage(deps, request.params.jobId, text));
    });

  app.post<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/cancel', { preHandler: limit(actionLimiter) }, async (request, reply) => {
      send(reply, await opJobCancel(deps, request.params.jobId));
    });

  app.post<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/verify', { preHandler: limit(actionLimiter) }, async (request, reply) => {
      send(reply, await opJobVerify(deps, request.params.jobId));
    });

  app.post<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/merge', { preHandler: limit(actionLimiter) }, async (request, reply) => {
      send(reply, await opJobMerge(deps, request.params.jobId));
    });

  app.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId/log', async (request, reply) => {
    send(reply, await opJobLog(deps, request.params.jobId));
  });

  app.put('/api/v1/config', async (request, reply) => {
    send(reply, await opConfigPut(deps, request.body));
  });
}
