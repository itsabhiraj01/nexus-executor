import { describe, expect, it } from 'vitest';
import { ChatOpenAI } from '@langchain/openai';
import { HarnessModelError, resolveModel } from './model.js';

const PROVIDERS = {
  local: { baseUrl: 'http://127.0.0.1:11434/v1' },
  hosted: { baseUrl: 'https://litellm.internal/v1', apiKey: 'sk-real-secret-value' },
} as const;

describe('resolveModel', () => {
  it('builds a ChatOpenAI pinned to the configured provider endpoint', () => {
    const m = resolveModel({ provider: 'local', model: 'qwen3' }, PROVIDERS, { timeoutMs: 5_000 });
    expect(m).toBeInstanceOf(ChatOpenAI);
    expect(m.model).toBe('qwen3');
    expect((m.clientConfig as Record<string, unknown>).baseURL).toBe('http://127.0.0.1:11434/v1');
    expect(m.timeout).toBe(5_000);
  });

  it('passes the provider key through without exposing it in errors', () => {
    const m = resolveModel({ provider: 'hosted', model: 'planner-pro' }, PROVIDERS);
    expect((m.clientConfig as Record<string, unknown>).apiKey).toBe('sk-real-secret-value');
    try {
      resolveModel({ provider: 'hosted', model: '' }, PROVIDERS);
      expect.unreachable('empty model must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessModelError);
      expect(JSON.stringify(error)).not.toContain('sk-real-secret-value');
    }
  });

  it('rejects an unconfigured provider as unknown_provider', () => {
    try {
      resolveModel({ provider: 'missing', model: 'anything' }, PROVIDERS);
      expect.unreachable('unknown provider must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessModelError);
      expect((error as HarnessModelError).code).toBe('unknown_provider');
      expect((error as Error).message).toContain('missing');
    }
  });

  it('rejects malformed refs as invalid_ref', () => {
    for (const bad of [
      { provider: '', model: 'x' },
      { provider: 'local', model: '  ' },
    ]) {
      expect(() => resolveModel(bad, PROVIDERS)).toThrowError(HarnessModelError);
      try { resolveModel(bad, PROVIDERS); } catch (error) {
        expect((error as HarnessModelError).code).toBe('invalid_ref');
      }
    }
  });
});
