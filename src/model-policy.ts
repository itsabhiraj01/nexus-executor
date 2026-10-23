/**
 * Agent-pinned model policy — the executor's enforcement half. The hub
 * decides the policy (the union of the job's agent's model providers) and
 * ships it in the job spec; the executor writes it into the job's isolated
 * worktree BEFORE the first session and PROVES the running OpenCode service
 * honors it with a canary (a real out-of-policy model that must be denied).
 * A service that cannot enforce policies fails the job launch instead of
 * running the agent unrestricted.
 *
 * Kept SELF-CONTAINED on purpose: the dependency-boundary lint forbids
 * importing `modules/*` from here, and the executor must stay deployable
 * without the hub's codebase. The semantics mirror the hub's
 * `modules/builder/src/opencode-model-policy.ts` — keep both in sync (the
 * wire shape is the job spec's `modelPolicy`).
 *
 * Verified against the live OpenCode v2.0.28 service (2026-10-13 probes):
 *  - `experimental.policies` in a per-directory opencode.json is honored at
 *    model RESOLUTION time: a denied request fails with `provider.no-route`
 *    before anything reaches the provider's network;
 *  - resources match provider IDs only (no `provider/model` granularity) —
 *    exact model pinning is the session's job (createSession.model pin);
 *  - directory config is sticky (loaded once per location) — write ONCE
 *    per fresh worktree, never into shared checkouts.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OpenCodeClient } from './opencode.js';
import { parseModelRef, type ModelRef } from './opencode.js';

/** One agent's contribution to the policy, as the hub's spec carries it. */
export interface ExecutorPolicySlice {
  agentId: string;
  agentName: string;
  agentVersion: number;
  models: string[];
  providers: string[];
}

/** The job-spec `modelPolicy` payload (mirrors the hub's wire shape). */
export interface ExecutorModelPolicy {
  agents: ExecutorPolicySlice[];
  providers: string[];
  models: string[];
}

/** Registration/enforcement failures — the launch wrapper turns them into
 *  a `model_policy_failed` job verdict. */
export class ModelPolicyError extends Error {}

/** True when an assistant-turn error is a provider-policy denial. */
export function isModelPolicyDenial(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && (error as { type?: unknown }).type === 'provider.no-route') return true;
  const message = typeof error === 'string'
    ? error
    : typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : '';
  return /no model is available|model unavailable:/i.test(message);
}

/** The `experimental.policies` block: deny-all baseline, one allow per
 *  provider (the last matching statement wins). */
export function renderPolicyBlock(providers: readonly string[]): Record<string, unknown> {
  return {
    policies: [
      { effect: 'deny', action: 'provider.use', resource: '*' },
      ...providers.map((provider) => ({ effect: 'allow', action: 'provider.use', resource: provider })),
    ],
  };
}

/** Merge the policy into an existing opencode.json document (pure): the
 *  statements land under BOTH keys — the stabilized top-level `policies`
 *  (current OpenCode spelling) and the compat `experimental.policies`
 *  (pre-stabilization, still honored) — REPLACING any existing policy
 *  arrays and preserving every other key. A service that reads only one of
 *  the two is fenced either way (the office-agent incident 2026-10-22 was
 *  exactly such a version skew), and the canary proves whichever key the
 *  running build honors. Replacement, never union: an additive merge would
 *  let a stale allow survive and silently widen the fence. */
export function mergePolicyIntoConfig(existing: unknown, providers: readonly string[]): Record<string, unknown> {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  const experimental = base.experimental && typeof base.experimental === 'object' && !Array.isArray(base.experimental)
    ? base.experimental as Record<string, unknown>
    : {};
  const statements = renderPolicyBlock(providers).policies;
  return {
    $schema: 'https://opencode.ai/config.json',
    ...base,
    policies: statements,
    experimental: {
      ...experimental,
      policies: statements,
    },
  };
}

/** write(tmp)+rename so the service's watcher never reads a half-written file. */
async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = join(resolve(file, '..'), `.opencode-json-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

/** Write the policy block into `<directory>/opencode.json` — fails rather
 *  than clobber an unparseable existing config. */
export async function writeModelPolicyConfig(directory: string, providers: readonly string[]): Promise<void> {
  const file = join(directory, 'opencode.json');
  let existing: unknown = null;
  try {
    existing = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ModelPolicyError(`The workspace's existing opencode.json is not valid JSON — the model policy cannot be merged into it (${(error as Error).message}).`);
    }
  }
  await atomicWrite(file, `${JSON.stringify(mergePolicyIntoConfig(existing, providers), null, 2)}\n`);
}

/**
 * Prove enforcement with a REAL denied model: create a probe session in the
 * same directory, pin an out-of-policy model from the service's own
 * listing, and require a `provider.no-route` answer within the budget.
 */
async function runCanary(client: OpenCodeClient, directory: string, canary: ModelRef, timeoutMs: number): Promise<void> {
  const session = await client.createSession({
    title: 'model-policy canary',
    directory,
    model: canary,
  });
  try {
    await client.prompt(session.id, 'Model policy probe — do not respond to this content.');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const messages = await client.getMessages(session.id);
      for (const message of messages) {
        if ((message.type === 'idle' || message.type === 'assistant') && isModelPolicyDenial(message.error)) return;
      }
      const working = messages.find((message) => message.type === 'assistant' && !isModelPolicyDenial(message.error));
      if (working) {
        throw new ModelPolicyError(
          `the canary model ${canary.providerID}/${canary.modelID} was NOT blocked by the directory's provider policy — this OpenCode service does not enforce experimental.policies`,
        );
      }
      if (Date.now() >= deadline) {
        throw new ModelPolicyError(
          `the canary model ${canary.providerID}/${canary.modelID} was not denied within ${Math.round(timeoutMs / 1000)}s — cannot prove the OpenCode service enforces the model policy`,
        );
      }
      await new Promise((done) => { setTimeout(done, 400); });
    }
  } finally {
    await client.interrupt(session.id).catch(() => { /* disposable */ });
  }
}

/**
 * Register the job's model policy on its isolated worktree: write the
 * allow-list, then PROVE it with a canary (a real configured model whose
 * provider the policy denies). When the service's listing names no
 * out-of-policy model (a single-provider service, or everything already
 * allowed) the file alone is the registration and `canary` stays null.
 * Throws ModelPolicyError otherwise — the caller fails the job launch.
 */
export async function registerModelPolicy(
  client: OpenCodeClient,
  directory: string,
  providers: readonly string[],
  opts: { canaryTimeoutMs?: number } = {},
): Promise<{ mode: 'enforced'; canary: string | null }> {
  await writeModelPolicyConfig(directory, providers);
  const allowed = new Set(providers);
  let listed;
  try {
    listed = await client.listModels(directory);
  } catch (error) {
    throw new ModelPolicyError(
      `the model listing failed while registering the model policy (${error instanceof Error ? error.message : String(error)}) — enforcement cannot be proven`,
    );
  }
  const canaryRef = listed.find((item) => !allowed.has(item.provider));
  if (canaryRef) {
    const parsed = parseModelRef(`${canaryRef.provider}/${canaryRef.id}`);
    if (parsed) await runCanary(client, directory, parsed, opts.canaryTimeoutMs ?? 15_000);
  }
  return { mode: 'enforced', canary: canaryRef ? `${canaryRef.provider}/${canaryRef.id}` : null };
}
