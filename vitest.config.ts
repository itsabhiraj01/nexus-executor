import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Some suites recreate the shared `executor` schema; serialized files
    // keep them from racing each other's rows.
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    // Job worktrees under data/ are full clones of the repos jobs ran on —
    // they contain the clone's OWN test suites (which need deps this
    // package does not install). Sweep leftovers would otherwise be
    // crawled by every `npm test`. (Setting `exclude` replaces vitest's
    // defaults, so node_modules/dist are repeated explicitly.)
    exclude: ['**/node_modules/**', '**/dist/**', 'data/**'],
  },
});
