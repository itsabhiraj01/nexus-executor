import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatGeneration, ChatResult } from '@langchain/core/outputs';

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

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const step = this.script[Math.min(this.step++, this.script.length - 1)]!;
    if (step.kind === 'hang') {
      return new Promise<ChatResult>(() => { /* never resolves */ });
    }
    let message: AIMessage;
    if (step.kind === 'tool_call') {
      message = new AIMessage({
        content: '',
        tool_calls: [{ id: `call_${this.step}`, name: step.name, args: step.args }],
      });
    } else {
      message = new AIMessage({ content: step.text });
    }
    const generation: ChatGeneration = { text: message.text, message };
    return { generations: [generation], llmOutput: {} };
  }
}
