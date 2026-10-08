import { parseArgs } from 'node:util';
import { pair, type PairResult } from '../pairing/core.js';
import { makePrompter, type Prompter } from '../pairing/prompts.js';

/**
 * `nexus-executor pair` — resolves transport/inputs (flag > env > prompt),
 * then delegates to the headless `pair()`. Gateway transport is the default;
 * passing `--hub <url>` opts into direct.
 */

export interface PairCliOptions {
  argv: string[];
  /** injectable fetch (tests) */
  fetchImpl?: typeof fetch;
  /** injectable prompter (defaults to real stdin/stdout) */
  prompt?: Prompter;
  /** default gateway URL shown in the prompt */
  defaultGatewayUrl?: string;
  /** injectable headless pair() (tests avoid a live DB for direct transport) */
  pairImpl?: typeof pair;
}

export interface PairCliResult extends PairResult {
  pairingCode: string;
  gatewayUrl?: string;
  hubUrl?: string;
}

export async function pairFromCli(opts: PairCliOptions): Promise<PairCliResult> {
  const { values } = parseArgs({
    args: opts.argv,
    allowPositionals: true,
    options: {
      gateway: { type: 'string' },
      hub: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
      'non-interactive': { type: 'boolean', short: 'y' },
    },
  });

  const interaction = opts.prompt ?? makePrompter();
  const nonInteractive = Boolean(values['non-interactive']);

  const gatewayFromEnv = process.env.GATEWAY_URL?.trim().replace(/\/+$/, '') || undefined;
  const hubFromEnv = process.env.HUB_URL?.trim().replace(/\/+$/, '') || undefined;
  const hubUrl = (values.hub as string | undefined) ?? hubFromEnv;
  const transport = hubUrl ? 'direct' : 'gateway';

  const codeFromEnv = process.env.PAIR_CODE?.trim() || undefined;
  let pairingCode = (values.code as string | undefined) ?? codeFromEnv;
  let gatewayUrl: string | undefined;

  if (transport === 'gateway') {
    gatewayUrl = (values.gateway as string | undefined)?.replace(/\/+$/, '') ?? gatewayFromEnv;
    if (!nonInteractive && !gatewayUrl) {
      gatewayUrl = await interaction('Gateway URL', opts.defaultGatewayUrl ?? 'https://gateway.example.com');
      gatewayUrl = gatewayUrl?.trim().replace(/\/+$/, '') || undefined;
    }
  }

  if (!nonInteractive && !pairingCode) {
    pairingCode = await interaction('Pairing code');
  }

  if (!pairingCode) {
    throw new Error('A pairing code is required (use --code, PAIR_CODE, or run interactively).');
  }

  const executorName = (values.name as string | undefined)
    ?? process.env.EXECUTOR_NAME?.trim()
    ?? process.env.HOSTNAME
    ?? 'executor';

  const doPair = opts.pairImpl ?? pair;
  const result = await doPair({
    transport,
    gatewayUrl,
    hubUrl,
    pairingCode,
    executorName,
    fetchImpl: opts.fetchImpl,
  });

  return { ...result, pairingCode, gatewayUrl, hubUrl };
}