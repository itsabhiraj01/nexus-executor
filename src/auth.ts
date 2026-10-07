import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

/**
 * Executor-side authentication: ONE-WAY TRUST.
 *
 * Pairing hands the executor a bearer token exactly once (over the pairing
 * call's response); the executor stores only its SHA-256 hex digest — the
 * raw token is never persisted here. Every `/api/v1/*` request carries
 * `Authorization: Bearer <token>`; the executor hashes what it receives and
 * compares 32-byte digests in constant time. A leaked database therefore
 * reveals nothing an attacker could present.
 *
 * `/health` is public (monitoring); everything under `/api/v1/` requires
 * the token, and answers 503 while the executor is still unpaired.
 */

export interface AuthConfig {
  tokenHash: string;
  hubUrl: string;
  name: string;
  pairedAt: string;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function readAuthConfig(pool: Pool): Promise<AuthConfig | null> {
  const { rows } = await pool.query<{ value: unknown }>(
    `SELECT value FROM executor.config WHERE key = 'auth'`,
  );
  const value = rows[0]?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.tokenHash)) return null;
  return {
    tokenHash: row.tokenHash,
    hubUrl: typeof row.hubUrl === 'string' ? row.hubUrl : '',
    name: typeof row.name === 'string' ? row.name : '',
    pairedAt: typeof row.pairedAt === 'string' ? row.pairedAt : '',
  };
}

export async function writeAuthConfig(pool: Pool, auth: AuthConfig): Promise<void> {
  await pool.query(
    `INSERT INTO executor.config (key, value, updated_at)
     VALUES ('auth', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(auth)],
  );
}

export async function clearAuthConfig(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM executor.config WHERE key = 'auth'`);
}

export interface AuthCheckResult {
  ok: boolean;
  statusCode: number;
  error: string;
}

/** Verify one request's bearer token against the stored hash. */
export async function checkRequestAuth(pool: Pool, authorization: string | undefined): Promise<AuthCheckResult> {
  const auth = await readAuthConfig(pool);
  if (!auth) {
    return { ok: false, statusCode: 503, error: 'This executor is not paired yet.' };
  }
  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
  if (!token) {
    return { ok: false, statusCode: 401, error: 'Missing bearer token: send "Authorization: Bearer <token>".' };
  }
  const presented = createHash('sha256').update(token).digest();
  const stored = Buffer.from(auth.tokenHash, 'hex');
  if (stored.length !== presented.length || !timingSafeEqual(presented, stored)) {
    return { ok: false, statusCode: 401, error: 'Invalid bearer token.' };
  }
  return { ok: true, statusCode: 200, error: '' };
}

/**
 * Fastify preHandler guarding every `/api/v1/*` route. `/health` and
 * anything outside the API stay public.
 */
export function createAuthHook(pool: Pool) {
  return async function authPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.url.startsWith('/api/v1/')) return;
    const check = await checkRequestAuth(pool, request.headers.authorization);
    if (!check.ok) {
      await reply.code(check.statusCode).send({ error: check.error });
    }
  };
}
