import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSupervisedCommand } from './tool-runner.js';

/** Real child processes — the point of this module is real cancellation. */
describe('runSupervisedCommand', () => {
  const scratchDirs: string[] = [];
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-runner-'));
    scratchDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  async function waitForGone(pid: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return true; }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it('captures stdout and exit code 0', async () => {
    const res = await runSupervisedCommand({ command: 'echo hello', cwd: scratch(), timeoutMs: 5_000, maxOutputBytes: 10_000 });
    expect(res).toMatchObject({ outcome: 'success', code: 0, truncated: false });
    expect(res.output).toContain('hello');
  });

  it('reports a nonzero exit with its code', async () => {
    const res = await runSupervisedCommand({ command: 'exit 3', cwd: scratch(), timeoutMs: 5_000, maxOutputBytes: 10_000 });
    expect(res).toMatchObject({ outcome: 'exit_nonzero', code: 3 });
  });

  it('timeout kills the whole process group — even a TERM-ignoring shell', async () => {
    const dir = scratch();
    const pidFile = join(dir, 'child.pid');
    const res = await runSupervisedCommand({
      // The backgrounded sleep defeats the last-command exec optimization; the
      // shell itself ignores SIGTERM, so only the group SIGKILL can reap it.
      command: 'trap "" TERM; echo $$ > "$PIDFILE"; sleep 120 & wait',
      cwd: dir, timeoutMs: 300, maxOutputBytes: 10_000,
      envOverrides: { PIDFILE: pidFile },
    });
    expect(res.outcome).toBe('timeout');
    expect(res.durationMs).toBeLessThan(4_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitForGone(pid, 3_000)).toBe(true);
  });

  it('caps captured output but keeps streaming every chunk to onOutput', async () => {
    let streamed = 0;
    const res = await runSupervisedCommand({
      command: 'yes outputline | head -c 200000',
      cwd: scratch(), timeoutMs: 10_000, maxOutputBytes: 5_000,
      onOutput: (chunk) => { streamed += chunk.length; },
    });
    expect(res.truncated).toBe(true);
    expect(res.output.length).toBeLessThanOrEqual(6_000);
    expect(streamed).toBeGreaterThan(190_000); // streaming is not capped
    expect(res.output).toContain('outputline'); // the tail survives
  });

  it('scrubs the environment: minimal base + explicit overrides only', async () => {
    process.env.MARKER_SECRET = 'leak';
    try {
      const dir = scratch();
      const res = await runSupervisedCommand({
        command: 'env', cwd: dir, timeoutMs: 5_000, maxOutputBytes: 20_000,
        envOverrides: { JOB_TOKEN: 'x' },
      });
      expect(res.outcome).toBe('success');
      expect(res.output).toContain('PATH=');
      expect(res.output).toContain(`HOME=${dir}`);
      expect(res.output).toContain('JOB_TOKEN=x');
      expect(res.output).not.toContain('MARKER_SECRET');
      expect(res.output).not.toContain('DATABASE_URL'); // vitest.setup sets it in OUR env
    } finally {
      delete process.env.MARKER_SECRET;
    }
  });

  it('aborts via AbortSignal as cancelled, killing the child', async () => {
    const dir = scratch();
    const pidFile = join(dir, 'sleep.pid');
    const controller = new AbortController();
    const pending = runSupervisedCommand({
      command: 'echo $$ > "$PIDFILE"; sleep 30 & wait',
      cwd: dir, timeoutMs: 60_000, maxOutputBytes: 10_000,
      envOverrides: { PIDFILE: pidFile }, signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    const res = await pending;
    expect(res.outcome).toBe('cancelled');
    expect(res.durationMs).toBeLessThan(3_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitForGone(pid, 3_000)).toBe(true);
  });

  it('resolves spawn_error for a missing cwd instead of throwing', async () => {
    const res = await runSupervisedCommand({
      command: 'true', cwd: '/definitely/missing/harness-runner-dir',
      timeoutMs: 5_000, maxOutputBytes: 10_000,
    });
    expect(res.outcome).toBe('spawn_error');
    expect(res.code).toBeNull();
  });
});
