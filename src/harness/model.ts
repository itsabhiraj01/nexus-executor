import { ChatOpenAI } from '@langchain/openai';

/**
 * The model gateway's resolution core (spec §Components §Model gateway +
 * §Credential custody). Provider endpoints and credentials come from the
 * EXECUTOR's own credential store (passed in here — Gate 1 builds the map
 * in-process; Gate 2 sources it from executor config). A `provider/model`
 * ref resolves to an explicit ChatOpenAI:
 *
 * - `maxRetries: 0` — silent provider retries are hidden extra attempts
 *   (spec §Reliability rules); the frozen chain's fallback is the ONLY
 *   fallback mechanism.
 * - `timeout` — without it a dead provider can hang a turn past every
 *   watchdog budget layered above.
 * - A missing key becomes 'unused' — local endpoints (Ollama) need none and
 *   the library still requires SOME string to construct.
 */

export interface HarnessProviderConfig {
  baseUrl: string;
  apiKey?: string;
}

/** One frozen link of an agent's model chain (frozen at dispatch). */
export interface FrozenModelRef {
  provider: string;
  model: string;
}

export type HarnessModelErrorCode =
  | 'unknown_provider'
  | 'invalid_ref'
  | 'model_policy_blocked'
  | 'provider_error';

export class HarnessModelError extends Error {
  constructor(readonly code: HarnessModelErrorCode, message: string) {
    super(message);
    this.name = 'HarnessModelError';
  }
}

export function resolveModel(
  ref: FrozenModelRef,
  providers: Record<string, HarnessProviderConfig>,
  opts?: { timeoutMs?: number },
): ChatOpenAI {
  if (!ref.provider || !ref.model?.trim()) {
    throw new HarnessModelError(
      'invalid_ref',
      `Model refs must be non-empty provider + model (got provider=${JSON.stringify(ref.provider)}, model=${JSON.stringify(ref.model)}).`,
    );
  }
  const provider = providers[ref.provider];
  if (!provider) {
    throw new HarnessModelError(
      'unknown_provider',
      `Provider "${ref.provider}" is not configured in this executor's credential store — add it there (or assign an agent chain on a configured provider).`,
    );
  }
  return new ChatOpenAI({
    model: ref.model,
    apiKey: provider.apiKey ?? 'unused',
    configuration: { baseURL: provider.baseUrl },
    // Must EXCEED the watchdog first-chunk budget or the client cancels
    // first and a watchdog-shaped failure reports as a bare HTTP timeout
    // (README §Task 7 coherence rule). 180 s > the 120 s default budget.
    timeout: opts?.timeoutMs ?? 180_000,
    maxRetries: 0,
  });
}
