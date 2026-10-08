import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { makePrompter } from './prompts.js';

describe('prompter', () => {
  it('prompts with the given question and returns the trimmed answer', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = makePrompter(input, output);
    const p = ask('Gateway URL?', 'https://default.example.com');
    input.write('https://gw.real.example.com\n');
    const answer = await p;
    expect(answer).toBe('https://gw.real.example.com');
  });

  it('returns the default when the user enters nothing', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = makePrompter(input, output);
    const p = ask('Gateway URL?', 'https://default.example.com');
    input.write('\n');
    expect(await p).toBe('https://default.example.com');
  });
});