import { createInterface, type Interface } from 'node:readline';
import { stdin as processStdin, stdout as processStdout } from 'node:process';

/**
 * Minimal stdin prompt helper, injectable so CLI tests can stub it. Uses
 * `node:readline`. `makePrompter(input, output)` returns a `Prompter`.
 */

export type Prompter = (question: string, defaultValue?: string) => Promise<string>;

export function makePrompter(
  input: NodeJS.ReadableStream = processStdin,
  output: NodeJS.WritableStream = processStdout,
): Prompter {
  const rl: Interface = createInterface({ input, output });
  const once = (q: string): Promise<string> => new Promise((resolve) => {
    rl.question(q, (answerRaw: string) => {
      resolve(answerRaw.trim());
    });
  });
  return async (question: string, defaultValue?: string) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await once(`${question}${suffix} `);
    return answer || defaultValue || '';
  };
}