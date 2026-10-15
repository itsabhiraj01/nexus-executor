import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage, type BaseMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatGeneration, type ChatResult } from '@langchain/core/outputs';

/**
 * Scripted chat model for deterministic harness tests (plan Task 5): upstream
 * has NO `FakeToolCallingChatModel` in @langchain/core 1.2.17 (see README
 * probe findings), and a flaky "real provider in unit tests" is not an
 * option. Each `_generate` consumes ONE script step — the agent's tool loop
 * calls the model again after each tool result, so a [tool_call, text]
 * script describes one full run.
 *
 * `bindTools` is a passthrough: the script answers with standard
 * `AIMessage.tool_calls` regardless of the schemas bound — Deep Agents only
 * needs the call to work, not the schema round trip.
 */

export type ScriptStep =
  | { kind: 'tool_call'; name: string; args: Record<string, unknown> }
  | { kind: 'text'; text: string }
  /** Streams the text as multiple deltas (real-provider shape). */
  | { kind: 'text_chunks'; chunks: string[] }
  /** A step whose generation never resolves — the cancel-path fixture. */
  | { kind: 'hang' };

export class ScriptedChatModel extends BaseChatModel {
  readonly script: ScriptStep[];
  /** Every message batch the agent sent — assertions read the tool results. */
  readonly calls: BaseMessage[][] = [];
  private step = 0;

  constructor(script: ScriptStep[], params?: BaseChatModelParams) {
    super(params ?? {});
    this.script = script;
  }

  _llmType(): string {
    return 'scripted-chat-model';
  }

  bindTools(): this {
    return this;
  }

  private take(messages: BaseMessage[]): ScriptStep {
    this.calls.push(messages);
    return this.script[Math.min(this.step++, this.script.length - 1)]!;
  }

  private messageFor(step: ScriptStep): AIMessage | AIMessageChunk {
    if (step.kind === 'tool_call') {
      return new AIMessage({
        content: '',
        tool_calls: [{ id: `call_${this.step}`, name: step.name, args: step.args }],
      });
    }
    if (step.kind === 'text') return new AIMessage({ content: step.text });
    if (step.kind === 'text_chunks') return new AIMessageChunk({ content: step.chunks.join('') });
    return new AIMessage({ content: '' });
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const step = this.take(messages);
    if (step.kind === 'hang') {
      return new Promise<ChatResult>(() => { /* never resolves */ });
    }
    const message = this.messageFor(step);
    const generation: ChatGeneration = { text: message.text, message };
    return { generations: [generation], llmOutput: {} };
  }

  /** Real providers stream DELTAS — the suite's accumulation/fixtures depend
   * on the scripted chunk boundaries below, not the default one-shot. */
  async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    const step = this.take(messages);
    if (step.kind === 'hang') {
      await new Promise<never>(() => { /* never resolves */ });
    }
    if (step.kind === 'text_chunks') {
      for (const piece of step.chunks) {
        yield new ChatGenerationChunk({ text: piece, message: new AIMessageChunk({ content: piece }) as BaseMessageChunk });
      }
      return;
    }
    const message = this.messageFor(step);
    yield new ChatGenerationChunk({ text: message.text, message: message as BaseMessageChunk });
  }
}
