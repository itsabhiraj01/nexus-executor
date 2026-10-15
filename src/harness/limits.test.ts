import { describe, expect, it } from 'vitest';
import { DEFAULT_HARNESS_LIMITS, resolveLimits, toolTimeoutFor } from './limits.js';

describe('resolveLimits', () => {
  it('returns the spec defaults', () => {
    expect(resolveLimits()).toEqual({
      firstChunkMs: 120_000,
      chunkGapMs: 120_000,
      turnCapMs: 30 * 60_000,
      toolDefaultMs: 120_000,
      toolMaxMs: 3_000_000,
      maxOutputBytes: 64 * 1024,
    });
  });

  it('clamps the output budget to the 1 MiB spec ceiling', () => {
    expect(resolveLimits({ maxOutputBytes: 10 * 1024 * 1024 }).maxOutputBytes).toBe(1024 * 1024);
    expect(resolveLimits({ maxOutputBytes: 512 * 1024 }).maxOutputBytes).toBe(512 * 1024);
  });

  it('applies overrides without touching the frozen defaults object', () => {
    const resolved = resolveLimits({ firstChunkMs: 5_000, toolMaxMs: 60_000 });
    expect(resolved.firstChunkMs).toBe(5_000);
    expect(resolved.toolMaxMs).toBe(60_000);
    expect(resolved.chunkGapMs).toBe(120_000);
    expect(DEFAULT_HARNESS_LIMITS.firstChunkMs).toBe(120_000);
  });

  it('clamps toolDefaultMs to toolMaxMs — an agent may not raise its own ceiling', () => {
    expect(resolveLimits({ toolDefaultMs: 500_000, toolMaxMs: 60_000 }).toolDefaultMs).toBe(60_000);
    expect(resolveLimits({ toolDefaultMs: 500_000 }).toolDefaultMs).toBe(500_000);
  });

  it.each(['firstChunkMs', 'chunkGapMs', 'turnCapMs', 'toolDefaultMs', 'toolMaxMs', 'maxOutputBytes'] as const)(
    'rejects non-positive %s naming the field',
    (field) => {
      expect(() => resolveLimits({ [field]: 0 })).toThrow(new RegExp(field));
      expect(() => resolveLimits({ [field]: -1 })).toThrow(new RegExp(field));
      expect(() => resolveLimits({ [field]: Number.NaN })).toThrow(new RegExp(field));
    },
  );
});

describe('toolTimeoutFor', () => {
  const limits = resolveLimits({ toolDefaultMs: 30_000, toolMaxMs: 120_000 });

  it('defaults to toolDefaultMs and honors a larger request within the ceiling', () => {
    expect(toolTimeoutFor(limits)).toBe(30_000);
    expect(toolTimeoutFor(limits, 90_000)).toBe(90_000);
  });

  it('clamps any request to toolMaxMs', () => {
    expect(toolTimeoutFor(limits, 10 * 60_000)).toBe(120_000);
  });

  it('falls back to the default on garbage requests', () => {
    expect(toolTimeoutFor(limits, Number.NaN)).toBe(30_000);
    expect(toolTimeoutFor(limits, -5)).toBe(30_000);
  });
});
