import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { startHarnessRun, type HarnessDriver } from './agent.js';
import { ScriptedChatModel, type ScriptStep } from './fake-model.js';
import { resolveLimits } from './limits.js';
import type { HarnessEvent } from './events.js';

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-agent-'));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

function makeDriver(script: ScriptStep[], dir: string, overrides?: { limits?: Parameters<typeof resolveLimits>[0] }): { driver: HarnessDriver; model: ScriptedChatModel } {
  const model = new ScriptedChatModel(script);
  const driver = startHarnessRun({
    threadId: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    prompt: 'Do the task.',
    model,
    workspaceDir: dir,
    limits: resolveLimits(overrides?.limits),
    checkpointer: new MemorySaver(),
  });
  return { driver, model };
}

async function collectUntil(events: AsyncIterable<HarnessEvent>, stop: (e: HarnessEvent) => boolean, max = 100): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (stop(event) || out.length >= max) break;
  }
  return out;
}

describe('startHarnessRun (Deep Agents + scripted model)', () => {
  it('runs the tool loop end-to-end: dispatch → result → completion, file on disk', async () => {
    const dir = scratch();
    const { driver } = makeDriver([
      { kind: 'tool_call', name: 'run_command', args: { command: 'echo harness-ok > note.txt' } },
      { kind: 'text', text: 'noted' },
    ], dir);

    const events = await collectUntil(driver.events, (e) => e.type === 'completion' || e.type === 'error');

    expect(events.some((e) => e.type === 'tool_dispatch' && e.tool === 'run_command')).toBe(true);
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ tool: 'run_command', outcome: 'success' });
    expect(events.at(-1)).toMatchObject({ type: 'completion', summary: 'noted' });
    expect(readFileSync(join(dir, 'note.txt'), 'utf8').trim()).toBe('harness-ok');
  });

  it('ask_user pauses on a question; answer() resumes exactly that question', async () => {
    const dir = scratch();
    const { driver, model } = makeDriver([
      { kind: 'tool_call', name: 'ask_user', args: { question: 'Pick a color?' } },
      { kind: 'text', text: 'You picked it' },
    ], dir);

    const first = await collectUntil(driver.events, (e) => e.type === 'question');
    const question = first.find((e) => e.type === 'question');
    expect(question).toMatchObject({ type: 'question', text: 'Pick a color?' });

    // Before an answer the run goes quiet: no completion may arrive early.
    const early = await Promise.race([
      (async () => {
        const it = driver.events;
        for await (const e of it) return e;
        return null;
      })(),
      new Promise((r) => setTimeout(() => r('quiet'), 700)),
    ]);
    expect(early).toBe('quiet');

    driver.answer((question as { questionId: string }).questionId, 'blue');
    const rest = await collectUntil(driver.events, (e) => e.type === 'completion' || e.type === 'error');
    expect(rest.at(-1)).toMatchObject({ type: 'completion', summary: 'You picked it' });

    // The answer reached the TOOL RESULT the model saw on its second call.
    const secondCall = model.calls[1] ?? [];
    const toolMessage = secondCall.find((m): m is ToolMessage => ToolMessage.isInstance(m));
    expect(toolMessage?.content).toBe('blue');
  });

  it('a tool timeout is a tool_result event, then the loop CONTINUES', async () => {
    const dir = scratch();
    const { driver } = makeDriver([
      { kind: 'tool_call', name: 'run_command', args: { command: 'sleep 60' } },
      { kind: 'text', text: 'recovered' },
    ], dir, { limits: { toolDefaultMs: 300 } });

    const startedAt = Date.now();
    const events = await collectUntil(driver.events, (e) => e.type === 'completion' || e.type === 'error');
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ tool: 'run_command', outcome: 'timeout' });
    expect(events.at(-1)).toMatchObject({ type: 'completion', summary: 'recovered' });
  });

  it('cancel() aborts a hung turn as an error event and settles resources', async () => {
    const dir = scratch();
    const { driver } = makeDriver([{ kind: 'hang' }, { kind: 'text', text: 'unreachable' }], dir);

    await new Promise((r) => setTimeout(r, 150));
    await driver.cancel();
    const events = await collectUntil(driver.events, (e) => e.type === 'error');
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error', code: 'cancelled' });
  });

  it('completion.summary is the accumulated response, not the last delta (review I4)', async () => {
    const dir = scratch();
    const { driver } = makeDriver([{ kind: 'text_chunks', chunks: ['Hello', ', ', 'world'] }], dir);

    const events = await collectUntil(driver.events, (e) => e.type === 'completion');
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    // Whatever the chunk granularity (merged here, per-token on a real
    // provider), joined deltas must equal the run's words — and the summary
    // must equal ALL of them, not the last delta (the pre-fix behavior).
    expect(texts.join('')).toBe('Hello, world');
    expect(events.at(-1)).toMatchObject({ type: 'completion', summary: 'Hello, world' });
  });

  it('a checkpoint-discovery failure is a VISIBLE error, never a silent fresh run (review I2)', async () => {
    class FlakySaver extends MemorySaver {
      override async *list(...args: unknown[]): AsyncGenerator<never> {
        void args;
        throw new Error('pg connection reset mid-discovery');
      }
    }
    const model = new ScriptedChatModel([{ kind: 'text', text: 'must never start' }]);
    const driver = startHarnessRun({
      threadId: `flaky-${Date.now()}`, prompt: 'Do the task.', model,
      workspaceDir: scratch(), limits: resolveLimits(),
      checkpointer: new FlakySaver(),
    });

    const events = await collectUntil(driver.events, (e) => e.type === 'error');
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error', code: 'model_error' });
    expect((error as { message?: string }).message).toContain('pg connection reset');
    expect(model.calls.length).toBe(0);
  });

  it('a watchdog timeout KILLS the in-flight tool — not just the consumer (review I3)', async () => {
    const dir = scratch();
    const { driver } = makeDriver([
      { kind: 'tool_call', name: 'run_command', args: { command: 'echo $$ > pid.txt; exec sleep 60' } },
      { kind: 'text', text: 'unreachable' },
    ], dir, { limits: { turnCapMs: 400, toolDefaultMs: 30_000 } });

    const events = await collectUntil(driver.events, (e) => e.type === 'error');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ type: 'error', code: 'watchdog_timeout' });

    // The run's abort raced into the tool wrapper; the group must be reaped.
    await new Promise((r) => setTimeout(r, 1_500));
    const pid = Number(readFileSync(join(dir, 'pid.txt'), 'utf8').trim());
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrowError(/ESRCH/);
  });
});
