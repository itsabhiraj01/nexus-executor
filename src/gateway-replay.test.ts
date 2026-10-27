import { describe, expect, it } from 'vitest';
import { GatewayRequestCache } from './gateway.js';

describe('gateway request replay', () => {
  it('coalesces pending mutations and replays the reply after reconnect', async () => {
    const cache = new GatewayRequestCache();
    let finish!: (value: unknown) => void;
    let calls = 0;
    const mutate = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
    const first = cache.run('request-1', 'job.message', { id: 'job', text: 'continue' }, mutate);
    const duplicate = cache.run('request-1', 'job.message', { text: 'continue', id: 'job' }, mutate);
    await Promise.resolve();
    expect(calls).toBe(1);
    finish({ ok: true });
    expect(await first).toEqual(await duplicate);
    expect(await cache.run('request-1', 'job.message', { id: 'job', text: 'continue' }, mutate)).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(await cache.run('request-1', 'job.cancel', { id: 'job' }, mutate)).toMatchObject({ ok: false, status: 409 });
    expect(await cache.run('request-1', 'job.message', { id: 'job', text: 'different' }, mutate)).toMatchObject({ ok: false, status: 409 });
    expect(calls).toBe(1);
  });
});
