/**
 * The normalized event vocabulary every harness emits (spec §Lifecycle and
 * durable events). This is the executor-internal contract: upstream stream
 * shapes stay behind the adapter in `agent.ts`, OpenCode message shapes stay
 * in `opencode.ts` — neither leaks into job handling.
 */

export type HarnessEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_dispatch'; callId: string; tool: string; args: Record<string, unknown> }
  | {
      type: 'tool_result'; callId: string; tool: string;
      outcome: 'success' | 'exit_nonzero' | 'timeout' | 'cancelled' | 'error';
      output: string; durationMs: number;
    }
  | { type: 'question'; questionId: string; text: string }
  | { type: 'completion'; summary: string }
  | {
      type: 'error';
      code: 'model_error' | 'watchdog_timeout' | 'cancelled' | 'tool_error' | 'unknown';
      message: string;
    }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number };
