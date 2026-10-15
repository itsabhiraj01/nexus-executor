import { describe, expect, it } from 'vitest';
import { createDeepAgent, CompositeBackend, FilesystemBackend, StateBackend } from 'deepagents';
import { BaseCheckpointSaver, Command, interrupt, MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from 'langchain';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { FakeStreamingChatModel } from '@langchain/core/utils/testing';

/**
 * Compile-time + runtime probe of every upstream surface Gate 1 builds on
 * (plan Task 0). Facts verified here are recorded in harness/README.md.
 */
describe('harness dependency probe', () => {
  it('exposes the surfaces Gate 1 builds on', () => {
    for (const value of [
      createDeepAgent, CompositeBackend, FilesystemBackend, StateBackend,
      BaseCheckpointSaver, Command, interrupt, MemorySaver, PostgresSaver,
      ChatOpenAI, tool, BaseChatModel,
    ]) {
      expect(typeof value).toBe('function');
    }
    // Task 6 needs ONE working constructor form; tries `new PostgresSaver(pool)`
    // first and falls back to `fromConnString`.
    expect(typeof PostgresSaver.fromConnString).toBe('function');
  });

  it('pins the deterministic-test building block actually in use', () => {
    // `FakeToolCallingChatModel` does not exist in @langchain/core 1.2.17 —
    // the suite uses our own ScriptedChatModel (fake-model.ts, Task 5), with
    // upstream's streaming fake kept as a referenced fallback.
    expect(FakeStreamingChatModel).toBeDefined();
  });
});
