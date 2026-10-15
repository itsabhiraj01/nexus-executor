import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

describe('container probe (plan Task 7)', () => {
  const require = createRequire(import.meta.url);
  const STACK = [
    'deepagents',
    'langchain',
    '@langchain/core',
    '@langchain/langgraph',
    '@langchain/langgraph-checkpoint-postgres',
    '@langchain/openai',
    'zod',
  ];

  it('no install hooks and no native bindings in the harness stack', () => {
    for (const name of STACK) {
      const pkgPath = require.resolve(`${name}/package.json`);
      const pkg = require(pkgPath) as { scripts?: Record<string, string> };
      const hooks = Object.keys(pkg.scripts ?? {}).filter((k) => /install/i.test(k));
      expect(hooks, `${name} must not ship install hooks`).toEqual([]);
      const natives = execFileSync('find', [dirname(pkgPath), '-name', '*.node']).toString().trim();
      expect(natives, `${name} must not contain native bindings`).toBe('');
    }
  });

  it('no TRANSITIVE install scripts beyond the pre-existing node-pty', () => {
    // node-pty and esbuild (via tsx) carry install scripts that PREDATE the
    // harness (--ignore-scripts on fresh installs is the documented
    // countermeasure); the harness stack must add NOTHING new.
    const lockPath = join(dirname(require.resolve('deepagents/package.json')), '..', '.package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages: Record<string, { hasInstallScript?: boolean }>;
    };
    const offenders = Object.entries(lock.packages)
      .filter(([key, value]) => key !== ''
        && value.hasInstallScript === true
        && !key.includes('node-pty')
        && !key.includes('esbuild'))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
