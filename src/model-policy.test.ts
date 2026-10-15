import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelPolicyError, isModelPolicyDenial, mergePolicyIntoConfig, renderPolicyBlock, writeModelPolicyConfig,
} from './model-policy.js';

/**
 * The executor's own contract for the hub's model-policy spec: deny-all
 * plus one allow per provider, merged into (never clobbering) an existing
 * worktree config, and an unparseable config is a launch-killing error —
 * mirroring the hub module's pinned semantics (which its own test suite
 * covers end-to-end, including the canary loop).
 */

describe('renderPolicyBlock', () => {
  it('denies every provider first, then allows exactly the listed ones', () => {
    expect(renderPolicyBlock(['astra', 'kimi'])).toEqual({
      policies: [
        { effect: 'deny', action: 'provider.use', resource: '*' },
        { effect: 'allow', action: 'provider.use', resource: 'astra' },
        { effect: 'allow', action: 'provider.use', resource: 'kimi' },
      ],
    });
  });
});

describe('mergePolicyIntoConfig', () => {
  it('preserves unrelated config roots while REPLACING a stale policy block', () => {
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      mcp: { db: { type: 'local', command: ['npx', 'srv'] } },
      experimental: { policies: [{ effect: 'allow', action: 'provider.use', resource: 'stale' }], other: true },
    };
    const merged = mergePolicyIntoConfig(existing, ['astra']) as {
      mcp: unknown; experimental: { policies: unknown[]; other: boolean };
    };
    expect(merged.mcp).toEqual(existing.mcp);
    expect(merged.experimental.other).toBe(true);
    // The stale allow is gone: the run's policy is the whole enforcement
    // intent — an additive union would silently widen it.
    expect(merged.experimental.policies).toEqual([
      { effect: 'deny', action: 'provider.use', resource: '*' },
      { effect: 'allow', action: 'provider.use', resource: 'astra' },
    ]);
  });

  it('tolerates non-object documents (treated as a fresh config)', () => {
    expect(mergePolicyIntoConfig('garbage', ['astra'])).toMatchObject({
      experimental: { policies: expect.any(Array) },
    });
  });
});

describe('writeModelPolicyConfig', () => {
  it('merges the policy into the worktree opencode.json and keeps a pre-existing document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-exec-policy-'));
    try {
      await writeFile(join(dir, 'opencode.json'), JSON.stringify({ mcp: { x: { type: 'remote', url: 'https://m' } } }));
      await writeModelPolicyConfig(dir, ['astra']);
      const written = JSON.parse(await readFile(join(dir, 'opencode.json'), 'utf8')) as {
        mcp: unknown; experimental: { policies: unknown[] };
      };
      expect(written.mcp).toEqual({ x: { type: 'remote', url: 'https://m' } });
      expect(written.experimental.policies).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to clobber an unparseable opencode.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-exec-policy-'));
    try {
      await writeFile(join(dir, 'opencode.json'), '{ not json');
      await expect(writeModelPolicyConfig(dir, ['astra'])).rejects.toBeInstanceOf(ModelPolicyError);
      await expect(writeModelPolicyConfig(dir, ['astra'])).rejects.toThrow('not valid JSON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isModelPolicyDenial', () => {
  it('matches the provider.no-route error shape the service reports', () => {
    expect(isModelPolicyDenial(undefined)).toBe(false);
    expect(isModelPolicyDenial({ type: 'provider.quota' })).toBe(false);
    expect(isModelPolicyDenial({ type: 'provider.no-route', message: 'No model available' })).toBe(true);
  });
});
