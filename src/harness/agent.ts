import { Command, MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { interrupt } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { createDeepAgent, CompositeBackend, FilesystemBackend, StateBackend } from 'deepagents';
import { tool } from 'langchain';
import { z } from 'zod';
import type { HarnessEvent } from './events.js';
import { toolTimeoutFor, type HarnessLimits } from './limits.js';
import { runSupervisedCommand } from './tool-runner.js';
import { watchStream, WatchdogAbort, WatchdogTimeout } from './watchdog.js';

/**
 * The Deep Agents adapter (spec §Components §Harness boundary + Gate 1 plan
 * Task 5): Nexus owns the lifecycle; Deep Agents supplies the conversational
 * loop. Dispatch/result events come from INSIDE the tool wrappers (a deterministic
 * push at call time) — never parsed back out of stream shapes — so upstream
 * version drift in stream layouts cannot silently invert what a job "did".
 *
 * Path rule (plan Task 5): the agent's FILE tools see the virtual
 * `/workspace/` prefix; `run_command` executes with cwd = the workspace, so
 * ITS paths are workspace-relative. The tool description says exactly that.
 */

export interface HarnessRunConfig {
  threadId: string;
  prompt: string;
  model: BaseChatModel;
  workspaceDir: string;
  systemBrief?: string;
  limits: HarnessLimits;
  checkpointer?: BaseCheckpointSaver;
}

export interface HarnessDriver {
  /** Pull-based: consumers control flow; at most one in-flight buffer. */
  events: AsyncIterable<HarnessEvent>;
  /** Resume the pending ask-user interrupt exactly once (answers are FIFO). */
  answer(questionId: string, text: string): void;
  cancel(): Promise<void>;
}

const DEFAULT_BRIEF = [
  'You are executing one build task inside an isolated workspace.',
  'Use run_command for shell work; its paths are workspace-relative.',
  'The file tools see the /workspace/ prefix; commands do not — use relative paths in commands.',
  'Use ask_user ONLY when blocked on a decision the human must make.',
  'When done, reply with a short completion summary.',
].join(' ');

class PushChannel<T> implements AsyncIterable<T> {
  private readonly queued: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: unknown = null;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queued.push(value);
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.finish();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.queued.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface PendingAnswer {
  questionId: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export function startHarnessRun(config: HarnessRunConfig): HarnessDriver {
  const events = new PushChannel<HarnessEvent>();
  const abort = new AbortController();
  let answerPending: PendingAnswer | null = null;
  let toolCounter = 0;

  const emit = (event: HarnessEvent): void => {
    if (!abort.signal.aborted || event.type === 'error') events.push(event);
  };

  const runCommandTool = tool(
    async ({ command, timeoutSeconds }: { command: string; timeoutSeconds?: number }) => {
      const callId = `tc-${++toolCounter}`;
      events.push({ type: 'tool_dispatch', callId, tool: 'run_command', args: timeoutSeconds ? { command, timeoutSeconds } : { command } });
      const result = await runSupervisedCommand({
        command,
        cwd: config.workspaceDir,
        timeoutMs: toolTimeoutFor(config.limits, timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000),
        maxOutputBytes: config.limits.maxOutputBytes,
        signal: abort.signal,
      });
      events.push({
        type: 'tool_result', callId, tool: 'run_command',
        outcome: result.outcome === 'spawn_error' ? 'error' : result.outcome,
        output: result.output.slice(-2_000), durationMs: result.durationMs,
      });
      return `outcome: ${result.outcome}${result.code === null ? '' : ` (exit ${result.code})`}\n${result.output}`;
    },
    {
      name: 'run_command',
      description: 'Run a shell command in the task workspace. Paths are WORKSPACE-RELATIVE (the command cwd IS the workspace — do NOT use /workspace/ prefixes here). Long builds may pass timeoutSeconds (≤ 3000).',
      schema: z.object({
        command: z.string().describe('The shell command to run'),
        timeoutSeconds: z.number().int().positive().max(3000).optional().describe('Optional timeout for slow builds/tests'),
      }),
    },
  );

  const askUserTool = tool(
    async ({ question }: { question: string }) => {
      const answer = interrupt({ type: 'ask_user', question }) as { text: string };
      return answer.text;
    },
    {
      name: 'ask_user',
      description: 'Ask the human a question and wait for the answer. Use ONLY when blocked on a decision the human must make.',
      schema: z.object({ question: z.string().describe('The exact question for the human') }),
    },
  );

  const agent = createDeepAgent({
    model: config.model,
    backend: new CompositeBackend(
      new StateBackend(),
      { '/workspace/': new FilesystemBackend({ rootDir: config.workspaceDir, virtualMode: true }) },
    ),
    tools: [runCommandTool, askUserTool],
    systemPrompt: config.systemBrief ?? DEFAULT_BRIEF,
    checkpointer: config.checkpointer ?? new MemorySaver(),
  });

  async function runLoop(): Promise<void> {
    let lastText = '';
    let questionCounter = 0;
    let sawInterrupt = false;
    try {
      let input: Record<string, unknown> | Command = { messages: [new HumanMessage(config.prompt)] };
      for (;;) {
        // Deep Agents' compiled-graph generics encode THEIR agent config; the
        // adapter intentionally treats the stream opaquely (tuple parsing is
        // validated at runtime below), hence the localized casts.
        const stream = await agent.stream(input as never, {
          configurable: { thread_id: config.threadId },
          streamMode: ['messages', 'updates'],
          signal: abort.signal,
        } as never);
        let pending: string | null = null;
        for await (const chunk of watchStream(
          stream as unknown as AsyncIterable<[string, unknown]>,
          { firstChunkMs: config.limits.firstChunkMs, chunkGapMs: config.limits.chunkGapMs, totalMs: config.limits.turnCapMs },
          abort.signal,
        )) {
          const [mode, data] = chunk;
          if (mode === 'messages') {
            const [token] = data as [{ getType?: () => string; text?: string; usage_metadata?: { input_tokens?: number; output_tokens?: number } }, unknown];
            if (token && typeof token.text === 'string' && token.text && token.getType?.() === 'ai') {
              lastText = token.text;
              emit({ type: 'text', text: token.text });
            }
            const usage = token?.usage_metadata;
            if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
              emit({ type: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens });
            }
          } else if (mode === 'updates') {
            const updates = data as Record<string, unknown> | undefined;
            const interrupts = updates?.__interrupt__ as Array<{ value?: unknown }> | undefined;
            const ask = interrupts?.map((entry) => entry?.value)
              .find((v): v is { type: 'ask_user'; question: string } =>
                Boolean(v) && typeof v === 'object' && (v as { type?: unknown }).type === 'ask_user' && typeof (v as { question?: unknown }).question === 'string');
            if (ask) {
              sawInterrupt = true;
              pending = `q${++questionCounter}`;
              emit({ type: 'question', questionId: pending, text: ask.question });
            }
          }
        }
        if (!pending) break;
        const text = await new Promise<string>((resolve, reject) => {
          answerPending = { questionId: pending!, resolve, reject };
        });
        answerPending = null;
        input = new Command({ resume: { text } });
      }
      if (lastText) emit({ type: 'completion', summary: lastText });
      else if (!sawInterrupt) emit({ type: 'error', code: 'unknown', message: 'The agent run ended without a completion message.' });
    } catch (error) {
      answerPending?.reject(error instanceof Error ? error : new Error(String(error)));
      if (error instanceof WatchdogAbort || abort.signal.aborted) {
        emit({ type: 'error', code: 'cancelled', message: 'Run cancelled.' });
      } else if (error instanceof WatchdogTimeout) {
        emit({ type: 'error', code: 'watchdog_timeout', message: `Model stream watchdog: ${error.kind}` });
      } else if (abort.signal.aborted) {
        emit({ type: 'error', code: 'cancelled', message: 'Run cancelled.' });
      } else {
        emit({ type: 'error', code: 'model_error', message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      events.finish();
    }
  }

  void runLoop();

  return {
    events,
    answer(questionId, text) {
      if (answerPending && answerPending.questionId === questionId) {
        answerPending.resolve(text);
      }
    },
    async cancel() {
      if (!abort.signal.aborted) abort.abort();
    },
  };
}
