import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ToolMessage } from '@langchain/core/messages';
import { startHarnessRun, type HarnessDriver } from './agent.js';
import { createCheckpointer } from './checkpoint.js';
import { ScriptedChatModel, type ScriptStep } from './fake-model.js';
import { resolveLimits } from './limits.js';
import type { HarnessEvent } from './events.js';

/**
 * Restart-resume across a real Postgres checkpoint (plan Task 6): driver A
 * interrupts on ask_user and DIES unanswered; driver B — a brand-new adapter
 * over the SAME saver/thread, with zero shared memory — sees the question
 * from the checkpoint (WITHOUT calling its model), answers it exactly once,
 * and completes.
 */

const schema = `ckpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ckpt-'));
  scratchDirs.push(dir);
  return dir;
}

async function collectUntil(events: AsyncIterable<HarnessEvent>, stop: (e: HarnessEvent) => boolean, max = 100): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (stop(event) || out.length >= max) break;
  }
  return out;
}

describe('createCheckpointer + restart-resume', () => {
  const databaseUrl = process.env.DATABASE_URL!;
  let checkpointer: Awaited<ReturnType<typeof createCheckpointer>>;

  afterEach(() => {
    while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  afterAll(async () => {
    await checkpointer?.close().catch(() => {});
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  function makeDriver(script: ScriptStep[], threadId: string, dir: string) {
    const model = new ScriptedChatModel(script);
    const driver: HarnessDriver = startHarnessRun({
      threadId, prompt: 'Do the task.', model,
      workspaceDir: dir, limits: resolveLimits(),
      checkpointer: checkpointer.saver,
    });
    return { driver, model };
  }

  it('creates checkpoint tables inside the isolated schema', async () => {
    checkpointer = await createCheckpointer(databaseUrl, schema);
    const { rows } = await checkpointer.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
      [schema],
    );
    expect(rows.map((r) => (r as { table_name: string }).table_name)).toContain('checkpoints');
  });

  it('resume comes from Postgres, not memory; the reply lands exactly once', async () => {
    const dir = scratch();
    const threadId = `job-${Date.now()}`;
    const scriptA: ScriptStep[] = [
      { kind: 'tool_call', name: 'ask_user', args: { question: 'Pick a color?' } },
      { kind: 'text', text: 'driver-A-must-never-speak' },
    ];

    // Driver A runs to the question and is then ABANDONED — a restart leaves
    // the interrupt durable; nothing answers on A's behalf.
    const a = makeDriver(scriptA, threadId, dir);
    const first = await collectUntil(a.driver.events, (e) => e.type === 'question');
    const question = first.find((e) => e.type === 'question');
    expect(question).toMatchObject({ type: 'question', text: 'Pick a color?' });
    const qid = (question as { questionId: string }).questionId;

    // Driver B: new adapter, new model instance, same saver + thread.
    const b = makeDriver([{ kind: 'text', text: 'You picked it' }], threadId, dir);
    const reJoined = await collectUntil(b.driver.events, (e) => e.type === 'question');
    expect(reJoined.find((e) => e.type === 'question')).toMatchObject({ type: 'question', text: 'Pick a color?' });
    // The question came from the checkpoint — B's model was never asked.
    expect(b.model.calls.length).toBe(0);

    const consumed = b.driver.answer(qid, 'blue');
    expect(consumed).toBe(true);
    const rest = await collectUntil(b.driver.events, (e) => e.type === 'completion' || e.type === 'error');
    expect(rest.at(-1)).toMatchObject({ type: 'completion', summary: 'You picked it' });
    const toolMessage = (b.model.calls[0] ?? []).find((m): m is ToolMessage => ToolMessage.isInstance(m));
    expect(toolMessage?.content).toBe('blue');

    // Exactly once: a late/duplicate answer is a deterministic rejection.
    expect(b.driver.answer(qid, 'green')).toBe(false);

    await a.driver.cancel();
    await b.driver.cancel();
  });

  it('a fresh thread has no interrupt to rejoin (guard against false-positive resume)', async () => {
    const dir = scratch();
    const driver = makeDriver([{ kind: 'text', text: 'fresh done' }], `fresh-${Date.now()}`, dir);
    const events = await collectUntil(driver.driver.events, (e) => e.type === 'completion' || e.type === 'error');
    expect(events.find((e) => e.type === 'question')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'completion' });
  });
});
