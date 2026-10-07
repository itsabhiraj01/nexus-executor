import { describe, expect, it } from 'vitest';
import {
  OpenCodeError,
  asksUserForInput,
  collectToolProgress,
  createOpenCodeClient,
  detectStall,
  evaluateToolProgress,
  finalAssistantText,
  lastAssistant,
  messageComplete,
  messageToEvents,
  normalizeModels,
  parseModelRef,
  readToolFingerprints,
  turnErrored,
  type OpenCodeMessage,
} from './opencode.js';

function assistant(id: string, parts: OpenCodeMessage['content'], extra: Partial<OpenCodeMessage> = {}): OpenCodeMessage {
  return { id, type: 'assistant', content: parts, finish: 'stop', time: { created: Date.now() }, ...extra };
}

describe('client', () => {
  it('sends HTTP Basic auth derived from the token', async () => {
    let seen = '';
    const client = createOpenCodeClient({
      baseUrl: 'http://stub',
      token: 's3cret',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen = String((init?.headers as Record<string, string>).authorization);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch,
    });
    await client.getMessages('ses_1');
    expect(seen).toBe(`Basic ${Buffer.from('opencode:s3cret').toString('base64')}`);
  });

  it('passes scheme-carrying tokens through verbatim', async () => {
    let seen = '';
    const client = createOpenCodeClient({
      baseUrl: 'http://stub',
      token: 'Bearer gateway-token',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen = String((init?.headers as Record<string, string>).authorization);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch,
    });
    await client.getMessages('ses_1');
    expect(seen).toBe('Bearer gateway-token');
  });

  it('tolerates 204 empty bodies (interrupt)', async () => {
    const client = createOpenCodeClient({
      baseUrl: 'http://stub',
      fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
    });
    await expect(client.interrupt('ses_1')).resolves.toBeUndefined();
  });

  it('raises OpenCodeError with the status on failures', async () => {
    const client = createOpenCodeClient({
      baseUrl: 'http://stub',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    });
    const failure = await client.getMessages('ses_1').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OpenCodeError);
    expect((failure as OpenCodeError).status).toBe(500);
  });
});

describe('messageToEvents + turn helpers', () => {
  it('normalizes assistant parts and markers, skipping user messages', () => {
    const message = assistant('m1', [
      { type: 'text', text: '  Made the change.  ' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool', tool: 'shell', state: { status: 'running' } },
      { type: 'tool', tool: 'read', state: { status: 'completed', output: 'x' } },
      { type: 'tool', tool: 'edit', state: { status: 'error', error: 'bad patch' } },
    ]);
    const events = messageToEvents(message);
    expect(events.map((event) => event.eventType)).toEqual([
      'AGENT_MESSAGE', 'AGENT_REASONING', 'TOOL_CALL_STARTED', 'TOOL_CALL_FINISHED', 'TOOL_CALL_FAILED',
    ]);
    expect(events[0]).toMatchObject({ summary: 'Made the change.', opencodeMessageId: 'm1:0' });
    expect(events[2]).toMatchObject({ opencodeMessageId: 'm1:2' });

    expect(messageToEvents({ id: 'u1', type: 'user' })).toEqual([]);
    expect(messageToEvents({ id: 'i1', type: 'idle', outcome: 'succeeded' })).toEqual([
      expect.objectContaining({ eventType: 'AGENT_IDLE', payload: { outcome: 'succeeded' } }),
    ]);
    expect(messageToEvents({ id: 'a1', type: 'agent-switched', previous: 'build', agent: 'plan' })).toEqual([
      expect.objectContaining({ eventType: 'AGENT_SWITCHED' }),
    ]);
  });

  it('messageComplete: open tool parts and tool-calls finish are not complete', () => {
    expect(messageComplete(assistant('m1', [{ type: 'text', text: 'hi' }]))).toBe(true);
    expect(messageComplete(assistant('m1', [{ type: 'tool', state: { status: 'running' } }]))).toBe(false);
    expect(messageComplete(assistant('m1', [{ type: 'text', text: 'hi' }], { finish: 'tool-calls' }))).toBe(false);
    expect(messageComplete(assistant('m1', [{ type: 'text', text: 'hi' }], { finish: null }))).toBe(false);
  });

  it('turnErrored only fires on completed turns with an error', () => {
    expect(turnErrored(assistant('m1', [], { error: 'boom' }))).toBe(true);
    expect(turnErrored(assistant('m1', [], { finish: 'error' }))).toBe(true);
    expect(turnErrored(assistant('m1', [], { finish: null }))).toBe(false);
    expect(turnErrored(assistant('m1', [{ type: 'text', text: 'ok' }]))).toBe(false);
  });

  it('asksUserForInput: question marks and ask phrases park the turn', () => {
    expect(asksUserForInput(assistant('m1', [{ type: 'text', text: 'Which database should I use?' }]))).toBe(true);
    expect(asksUserForInput(assistant('m1', [{ type: 'text', text: 'All done. Should I proceed with the deploy?' }]))).toBe(true);
    expect(asksUserForInput(assistant('m1', [{ type: 'text', text: 'Implemented the feature, tests pass.' }]))).toBe(false);
  });

  it('finalAssistantText picks the last non-empty text part', () => {
    expect(finalAssistantText(assistant('m1', [
      { type: 'text', text: 'first' }, { type: 'tool', state: { status: 'completed' } }, { type: 'text', text: ' last ' },
    ]))).toBe('last');
  });

  it('lastAssistant picks by time.created regardless of array order', () => {
    const older = assistant('m-old', [], { time: { created: 1 } });
    const newer = assistant('m-new', [], { time: { created: 100 } });
    expect(lastAssistant([newer, older])?.id).toBe('m-new');
    expect(lastAssistant([])).toBeNull();
  });
});

describe('stall detection', () => {
  const now = 1_800_000_000_000;
  it('flags a tool running past the tool threshold with a command preview', () => {
    const stale = assistant('m1', [
      { type: 'tool', tool: 'shell', state: { status: 'running', input: { command: 'npm test   --watch' } }, time: { ran: now - 51 * 60_000 } },
    ], { finish: null, time: { created: now - 51 * 60_000 } });
    const stall = detectStall([stale], { now, toolStallMs: 50 * 60_000, silenceStallMs: 0 });
    expect(stall).toMatchObject({ kind: 'tool' });
    expect(stall!.summary).toContain('51 minutes');
    expect(stall!.summary).toContain("'npm test --watch'");
  });

  it('flags a silent in-flight turn and leaves healthy + completed turns alone', () => {
    const silent = assistant('m1', [{ type: 'text', text: 'hmm' }], { finish: null, time: { created: now - 21 * 60_000 } });
    expect(detectStall([silent], { now, toolStallMs: 0, silenceStallMs: 20 * 60_000 })).toMatchObject({ kind: 'silence' });
    const healthy = assistant('m1', [
      { type: 'tool', state: { status: 'running' }, time: { ran: now - 60_000 } },
    ], { finish: null, time: { created: now - 60_000 } });
    expect(detectStall([healthy], { now, toolStallMs: 50 * 60_000, silenceStallMs: 20 * 60_000 })).toBeNull();
    const done = assistant('m1', [{ type: 'text', text: 'done' }], { time: { created: now - 3_600_000 } });
    expect(detectStall([done], { now, toolStallMs: 1, silenceStallMs: 1 })).toBeNull();
  });

  it('evaluateToolProgress: changed fingerprints never stall, frozen ones fail, zero-output parts fail on first sight', () => {
    const tool = (output: string | undefined, ran: number): OpenCodeMessage =>
      assistant('m1', [{ type: 'tool', tool: 'shell', state: output === undefined ? { status: 'running' } : { status: 'running', output }, time: { ran } }], { finish: null, time: { created: ran } });

    // First sight WITH output: no stall, clock starts at now.
    let active = collectToolProgress([tool('chunk 1', now - 30 * 60_000)]);
    let result = evaluateToolProgress(active, {}, { now, toolProgressMs: 10 * 60_000 });
    expect(result.stalled).toBeNull();
    expect(result.store['m1:0']?.changedAt).toBe(now);

    // Same fingerprint 11 minutes later: stalled (no progress for the threshold).
    result = evaluateToolProgress(active, result.store, { now: now + 11 * 60_000, toolProgressMs: 10 * 60_000 });
    expect(result.stalled).toMatchObject({ kind: 'no-progress' });

    // Changed fingerprint: clock restarts, no stall.
    active = collectToolProgress([tool('chunk 1 chunk 2', now - 30 * 60_000)]);
    result = evaluateToolProgress(active, { 'm1:0': { fingerprint: 'old', changedAt: now - 30 * 60_000 } }, { now, toolProgressMs: 10 * 60_000 });
    expect(result.stalled).toBeNull();
    expect(result.store['m1:0']?.changedAt).toBe(now);

    // Wedged from birth: older than the threshold with zero output → first-sight failure.
    active = collectToolProgress([tool(undefined, now - 15 * 60_000)]);
    result = evaluateToolProgress(active, {}, { now, toolProgressMs: 10 * 60_000 });
    expect(result.stalled?.summary).toContain('zero output');

    // Store round trip through metadata-shaped JSON.
    expect(readToolFingerprints({ toolFingerprints: result.store })['m1:0']?.changedAt).toBe(now);
    expect(readToolFingerprints({ toolFingerprints: 'junk' })).toEqual({});
  });
});

describe('models', () => {
  it('normalizeModels maps raw rows and parseModelRef splits on the first slash', () => {
    expect(normalizeModels([
      { id: 'gpt-5', name: 'GPT 5', providerID: 'litellm' },
      { id: 'no-provider', name: 'No provider' },
      { name: 'no id', provider: 'x' },
      { id: 'mini', provider: 'ollama' },
    ])).toEqual([
      { id: 'no-provider', name: 'No provider', provider: '' },
      { id: 'gpt-5', name: 'GPT 5', provider: 'litellm' },
      { id: 'mini', name: 'mini', provider: 'ollama' },
    ]);
    expect(parseModelRef('litellm/open-large')).toEqual({ providerID: 'litellm', modelID: 'open-large' });
    expect(parseModelRef('acme/team/model-x')).toEqual({ providerID: 'acme', modelID: 'team/model-x' });
    expect(parseModelRef('noslash')).toBeNull();
    expect(parseModelRef('/model')).toBeNull();
  });
});
