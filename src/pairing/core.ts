import { loadConfig } from '../config.js';
import { writeCliState } from './state.js';

/**
 * Headless pairing — the ONLY place pairing is implemented. Callers resolve
 * inputs (prompts/flags); this resolves transport, produces/persists the
 * credential, and writes the CLI state index. It never prompts and never
 * owns UI, so the installer, the CLI, and (later) a TUI all call the same
 * function.
 *
 * Transport is decided by the caller: gateway (default) or direct (`--hub`).
 */

export type PairTransport = 'gateway' | 'direct';

export interface PairRequest {
  transport: PairTransport;
  /** gateway transport — public gateway base URL */
  gatewayUrl?: string;
  /** direct transport — hub base URL */
  hubUrl?: string;
  /** single-use pairing/enrollment code */
  pairingCode: string;
  /** display name; falls back to the host name when unset */
  executorName: string;
  /** injectable fetch (tests) */
  fetchImpl?: typeof fetch;
}

export interface PairResult {
  transport: PairTransport;
  /** Gateway: the executor id issued by the hub. Direct: present when the hub returned it. */
  executorId?: string;
  name: string;
}

export async function pair(req: PairRequest): Promise<PairResult> {
  const base = loadConfig();

  if (req.transport === 'gateway') {
    const code = req.pairingCode.trim().toUpperCase();
    if (!code) throw new Error('A pairing code is required.');
    const gatewayUrl = (req.gatewayUrl ?? '').trim().replace(/\/+$/, '');
    if (!gatewayUrl) throw new Error('A gateway URL is required for gateway pairing.');
    try {
      const { enrollGateway } = await import('../gateway.js');
      const identity = await enrollGateway(
        { ...base, gatewayUrl, pairCode: code, executorName: req.executorName },
        { fetchImpl: req.fetchImpl },
      );
      await writeCliState({
        transport: 'gateway',
        gatewayUrl,
        name: req.executorName,
        enrolledAt: identity.enrolledAt,
        identityPath: base.gatewayIdentityPath,
      });
      return { transport: 'gateway', executorId: identity.executorId, name: req.executorName };
    } catch (error) {
      throw new Error(`Gateway pairing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Direct transport.
  const hubUrl = (req.hubUrl ?? '').trim().replace(/\/+$/, '');
  if (!hubUrl) throw new Error('A hub URL is required for direct pairing (or leave it unset for gateway).');
  try {
    const { createPool } = await import('../db.js');
    const pool = createPool(base.databaseUrl);
    try {
      const { claimPairing } = await import('../pairing.js');
      const outcome = await claimPairing(
        { ...base, hubUrl, pairCode: req.pairingCode, executorName: req.executorName },
        pool,
        { fetchImpl: req.fetchImpl },
      );
      if (!outcome.alreadyPaired) {
        await writeCliState({
          transport: 'direct',
          hubUrl,
          name: outcome.name ?? req.executorName,
          pairedAt: new Date().toISOString(),
        });
      }
      return { transport: 'direct', executorId: outcome.id, name: outcome.name ?? req.executorName };
    } finally {
      await pool.end().catch(() => {});
    }
  } catch (error) {
    throw new Error(`Direct pairing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Pick the transport for the running service. CLI state wins; otherwise fall
 * back to the env's EXECUTOR_TRANSPORT (legacy/containerized installs).
 */
export function selectTransport(
  envTransport: string | undefined,
  stateTransport: 'gateway' | 'direct' | null,
): 'gateway' | 'direct' {
  if (stateTransport === 'gateway' || stateTransport === 'direct') return stateTransport;
  return envTransport === 'gateway' ? 'gateway' : 'direct';
}