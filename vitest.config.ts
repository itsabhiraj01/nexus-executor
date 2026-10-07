import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Some suites recreate the shared `executor` schema; serialized files
    // keep them from racing each other's rows.
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
  },
});
