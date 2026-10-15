/**
 * Harness reliability budgets (spec §Reliability rules). Every value is
 * frozen per run at admission; nothing inside a run may raise them — in
 * particular an agent's own tool-timeout REQUEST is clamped by
 * `limits.toolMaxMs`, never honored above it.
 *
 * Defaults mirror the spec table: model first-response 120 s, inter-chunk
 * 120 s, absolute turn 10 min, tool default 120 s, tool ceiling 50 min,
 * output 100_000 bytes.
 */

export interface HarnessLimits {
  /** Max wait for the first streamed item of a turn. */
  firstChunkMs: number;
  /** Max gap between two streamed items. */
  chunkGapMs: number;
  /** Absolute cap for one turn; repeated output never extends it. */
  turnCapMs: number;
  /** Default tool timeout when a call asks for none. */
  toolDefaultMs: number;
  /** Hard ceiling for ANY tool timeout (requested or defaulted). */
  toolMaxMs: number;
  /** Captured output cap per tool call (tail is kept beyond it). */
  maxOutputBytes: number;
}

export const DEFAULT_HARNESS_LIMITS: HarnessLimits = {
  firstChunkMs: 120_000,
  chunkGapMs: 120_000,
  turnCapMs: 600_000,
  toolDefaultMs: 120_000,
  toolMaxMs: 50 * 60_000,
  maxOutputBytes: 100_000,
};

const FIELDS = [
  'firstChunkMs', 'chunkGapMs', 'turnCapMs',
  'toolDefaultMs', 'toolMaxMs', 'maxOutputBytes',
] as const;

/** Merge overrides over the defaults, validating and clamping. */
export function resolveLimits(overrides: Partial<HarnessLimits> = {}): HarnessLimits {
  const limits = { ...DEFAULT_HARNESS_LIMITS };
  for (const field of FIELDS) {
    const value = overrides[field];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${field} must be a positive number, got ${JSON.stringify(value)}`);
    }
    limits[field] = Math.floor(value);
  }
  if (limits.toolDefaultMs > limits.toolMaxMs) {
    limits.toolDefaultMs = limits.toolMaxMs;
  }
  return limits;
}

/**
 * Effective timeout for one tool call: the call may ask for more than the
 * default (slow builds are legitimate) but never past the run ceiling.
 */
export function toolTimeoutFor(limits: HarnessLimits, requestedMs?: number): number {
  const wanted = requestedMs === undefined ? limits.toolDefaultMs : requestedMs;
  if (!Number.isFinite(wanted) || wanted <= 0) return limits.toolDefaultMs;
  return Math.min(Math.floor(wanted), limits.toolMaxMs);
}
