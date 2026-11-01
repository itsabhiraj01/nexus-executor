/** Wire-compatible with the hub's pipeline-blockers.ts; keep these semantics
 * local because the executor is independently deployed. */
export function stageBlocker(output: string): { errorCode: string; reason: string } | null {
  const records = output.split('\n').filter(line => line.startsWith('NEXUS_STAGE_RESULT:'));
  if (!records.length) return null; // Already-dispatched legacy output.
  const invalid = { errorCode: 'invalid_pipeline_result', reason: 'The stage returned an invalid completion record. Retry this stage with the current completion contract.' };
  if (records.length !== 1 || output.trimEnd().split('\n').at(-1) !== records[0]) return invalid;
  let result: Record<string, unknown>;
  try { result = JSON.parse(records[0]!.slice('NEXUS_STAGE_RESULT:'.length)); } catch { return invalid; }
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.summary !== 'string' || !result.summary.trim()) return invalid;
  if (result.status === 'complete') return result.reason === undefined ? null : invalid;
  if (result.status !== 'blocked' && result.status !== 'incomplete') return invalid;
  const codes: Record<string, string> = { input: 'pipeline_input_required', permission: 'pipeline_permission_required',
    implementation: 'pipeline_implementation_incomplete', verification: 'pipeline_verification_incomplete' };
  const errorCode = typeof result.reason === 'string' ? codes[result.reason] : undefined;
  return errorCode ? { errorCode, reason: result.summary.trim().slice(0, 2000) } : invalid;
}

/** The hub's pipelineStageRemoteSpec job-id contract, including repair generations. */
export function requiresStageResult(hubJobId: string): boolean {
  return /:(?:code|test)(?::[0-9]+)?$/.test(hubJobId);
}
