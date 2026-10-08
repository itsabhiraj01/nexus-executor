import { randomBytes, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { EXECUTOR_VERSION, type ExecutorConfig } from './config.js';
import { GATEWAY_PROTOCOL_VERSION, handleGatewayOperation, type RouteDeps } from './ops.js';

/**
 * Gateway transport (EXECUTOR_TRANSPORT=gateway): instead of listening for
 * hub HTTP calls, this executor dials OUT — enroll once, then hold an
 * authenticated WebSocket to the nexus-gateway service (via Cloudflare
 * Tunnel) and answer the canonical nexus.executor.v1 operations it relays.
 *
 * Identity: an Ed25519 keypair generated at first enroll; the private key
 * never leaves GATEWAY_IDENTITY_PATH (mode 0600). The connect proof signs
 * audience‖credential‖timestamp‖nonce — the gateway validates nothing but
 * shapes, the hub verifies the signature and consumes the nonce.
 *
 * Reconnects use exponential backoff with jitter (the gateway cannot ask us
 * to reconnect; that is OUR job) and never give up: an executor outlives
 * gateway restarts and hub deploys.
 */

interface GatewayIdentity {
  version: 1;
  credential: string;
  executorId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  enrolledAt: string;
}

const PROOF_AUDIENCE = 'NEXUS-GATEWAY-CONNECT v1';
const MAX_MESSAGE_BYTES = 48 * 1024 * 1024;
const MAX_IN_FLIGHT = 16;

function identityPath(config: ExecutorConfig): string {
  return config.gatewayIdentityPath;
}

export function readGatewayIdentity(config: ExecutorConfig): GatewayIdentity | null {
  const path = identityPath(config);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GatewayIdentity>;
    if (raw.version !== 1 || typeof raw.credential !== 'string' || typeof raw.executorId !== 'string'
      || typeof raw.publicKeyPem !== 'string' || typeof raw.privateKeyPem !== 'string') return null;
    return raw as GatewayIdentity;
  } catch {
    return null;
  }
}

function writeGatewayIdentity(config: ExecutorConfig, identity: GatewayIdentity): void {
  const path = identityPath(config);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * One-shot enrollment through the gateway's public POST /v1/enroll, paid
 * with the single-use Builder pairing code. The hub's response ({credential,
 * executorId}) plus the keypair are stored once; losing them = re-pair.
 */
export async function enrollGateway(
  config: ExecutorConfig,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<GatewayIdentity> {
  const existing = readGatewayIdentity(config);
  if (existing) return existing;
  if (!config.gatewayUrl) throw new Error('GATEWAY_URL is required when EXECUTOR_TRANSPORT=gateway.');
  if (!config.pairCode) {
    throw new Error('Not enrolled and PAIR_CODE is unset — mint a pairing code in Builder → Executors and set it.');
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const doFetch = options.fetchImpl ?? fetch;
  const res = await doFetch(`${config.gatewayUrl}/v1/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollment_token: config.pairCode.trim().toUpperCase(),
      executor_public_key: publicKeyPem,
      agent_version: EXECUTOR_VERSION,
      protocol_version: GATEWAY_PROTOCOL_VERSION,
      name: config.executorName,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Gateway enrollment failed (${res.status}) — check the pairing code and the gateway route.`);
  }
  const body = await res.json() as { credential?: unknown; executorId?: unknown };
  if (typeof body.credential !== 'string' || typeof body.executorId !== 'string') {
    throw new Error('Gateway enrollment returned a malformed response.');
  }
  const identity: GatewayIdentity = {
    version: 1,
    credential: body.credential,
    executorId: body.executorId,
    publicKeyPem,
    privateKeyPem,
    enrolledAt: new Date().toISOString(),
  };
  writeGatewayIdentity(config, identity);
  return identity;
}

export interface GatewayLoopOptions {
  logger: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
  isStopped?: () => boolean;
  webSocketImpl?: typeof WebSocket;
}

/**
 * The reconnect loop: enroll (once) → connect with a fresh proof → serve
 * requests until close → back off → repeat. Resolves when isStopped() is
 * first observed true between attempts; the caller owns shutdown ordering.
 */
export async function runGatewayLoop(deps: RouteDeps, config: ExecutorConfig, options: GatewayLoopOptions): Promise<void> {
  const { logger } = options;
  const stopped = options.isStopped ?? (() => false);
  const Ws = options.webSocketImpl ?? WebSocket;
  const identity = await enrollGateway(config);
  const wsBase = config.gatewayUrl!.replace(/^http/, 'ws');
  let attempt = 0;
  let inFlight = 0;

  while (!stopped()) {
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('base64url');
    const proof = ed25519Sign(
      null,
      Buffer.from(`${PROOF_AUDIENCE}\n${identity.credential}\n${timestamp}\n${nonce}`, 'utf8'),
      identity.privateKeyPem,
    ).toString('base64url');

    const ws = new Ws(`${wsBase}/v1/connect`, {
      headers: {
        authorization: `Bearer ${identity.credential}`,
        'x-nexus-proof-ts': timestamp,
        'x-nexus-proof-nonce': nonce,
        'x-nexus-proof': proof,
      },
      maxPayload: MAX_MESSAGE_BYTES,
    });

    const outcome = await new Promise<'closed'>((resolve) => {
      ws.on('open', () => {
        attempt = 0;
        logger.info({ url: wsBase }, 'gateway session established');
      });
      ws.on('message', (data: Buffer | Buffer[]) => {
        if (inFlight >= MAX_IN_FLIGHT) return; // shed: hub-side deadlines expire; never block the loop
        const buffer = Array.isArray(data) ? Buffer.concat(data) : data;
        inFlight++;
        void handleRequest(ws, deps, buffer)
          .catch(() => {}) // a malformed message is answered with nothing (gateway closes if it cares)
          .finally(() => { inFlight--; });
      });
      ws.on('error', () => {});
      ws.once('close', () => resolve('closed'));
    });
    void outcome;

    if (stopped()) break;
    // Exponential backoff with full jitter: 1s → 30s ceiling.
    attempt = Math.min(attempt + 1, 12);
    const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    const delay = Math.floor(Math.random() * ceiling);
    logger.warn({ delayMs: delay, attempt }, 'gateway session lost; reconnecting');
    await sleep(delay);
  }

  async function handleRequest(socket: WebSocket, depsArg: RouteDeps, data: Buffer): Promise<void> {
    let id: string | undefined;
    let operation: string | undefined;
    try {
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as Record<string, unknown>;
      if (envelope.version !== GATEWAY_PROTOCOL_VERSION || envelope.type !== 'request') return;
      if (typeof envelope.id !== 'string' || !envelope.id.length || envelope.id.length > 128) return;
      if (typeof envelope.operation !== 'string') return;
      id = envelope.id;
      operation = envelope.operation;
      const result = await handleGatewayOperation(depsArg, operation, envelope.payload);
      const response = JSON.stringify({
        version: GATEWAY_PROTOCOL_VERSION, type: 'response', id, operation, payload: result,
      });
      if (Buffer.byteLength(response) > MAX_MESSAGE_BYTES) {
        throw new Error('response too large');
      }
      socket.send(response);
    } catch {
      if (id && operation && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({
          version: GATEWAY_PROTOCOL_VERSION, type: 'response', id, operation,
          payload: { ok: false, error: 'Executor failed to produce the response.', status: 500 },
        }));
      }
    }
  }
}
