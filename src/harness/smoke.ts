import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarnessRun } from './agent.js';
import { resolveModel } from './model.js';
import { resolveLimits } from './limits.js';

/**
 * Real-model smoke (plan Task 7): a scripted run through the FULL stack —
 * model gateway → Deep Agents adapter → supervised tools → watchdog — with a
 * REAL provider. Opt-in: requires HARNESS_SMOKE_BASE_URL + HARNESS_SMOKE_MODEL
 * (HARNESS_SMOKE_API_KEY optional). A cheap LOCAL endpoint (Ollama) is the
 * intended default: it proves config plumbing + real token streaming +
 * tool-loop wiring, not plan quality.
 */

const baseUrl = process.env.HARNESS_SMOKE_BASE_URL;
const modelName = process.env.HARNESS_SMOKE_MODEL;

if (!baseUrl || !modelName) {
  console.log('[smoke] skipped — set HARNESS_SMOKE_BASE_URL + HARNESS_SMOKE_MODEL '
    + '(e.g. HARNESS_SMOKE_BASE_URL=http://127.0.0.1:11434/v1 HARNESS_SMOKE_MODEL=llama3.2:latest)');
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), 'harness-smoke-'));
console.log('[smoke] provider', baseUrl, '| model', modelName, '| workspace', workspace);

let exitCode = 1;
const model = resolveModel(
  { provider: 'smoke', model: modelName },
  { smoke: { baseUrl, apiKey: process.env.HARNESS_SMOKE_API_KEY } },
  // HTTP timeout must exceed the first-chunk watchdog or the client layer
  // cancels first (observed: "Request timed out." at the 120 s default).
  { timeoutMs: 300_000 },
);
const driver = startHarnessRun({
  threadId: `smoke-${Date.now()}`,
  prompt: 'Create a file named smoke.txt in this workspace containing the single word "ok" '
    + '(one way: run_command with `echo ok > smoke.txt`). Then reply with just DONE.',
  model,
  workspaceDir: workspace,
  // Budgets are relaxed for cheap LOCAL endpoints: a cold/contended CPU
  // model may take a minute per burst (observed 48 s to first chunk).
  limits: resolveLimits({ toolDefaultMs: 15_000, firstChunkMs: 120_000, chunkGapMs: 150_000 }),
});
const deadline = setTimeout(() => {
  console.error('[smoke] HARD TIMEOUT (420s) — cancelling the run');
  void driver.cancel().finally(() => {
    rmSync(workspace, { recursive: true, force: true });
    process.exit(2);
  });
}, 420_000);

let completed = false;
for await (const event of driver.events) {
  console.log('[smoke]', event.type, JSON.stringify(event).slice(0, 220));
  if (event.type === 'completion') completed = true;
  if (event.type === 'error') break;
}
clearTimeout(deadline);

const fileOk = existsSync(join(workspace, 'smoke.txt'));
console.log('[smoke] RESULT: completion =', completed, '| smoke.txt on disk =', fileOk);
exitCode = completed ? 0 : 1;
// Cleanup BEFORE exit — a finally-block runs too late behind process.exit.
rmSync(workspace, { recursive: true, force: true });
process.exit(exitCode);
