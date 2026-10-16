import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Some suites recreate the shared `executor` schema; serialized files
    // keep them from racing each other's rows. globalSetup mints a private
    // nexus_executor_run_<epoch>_<rand>_test database per run — the shared
    // nexus_executor_test is world-writable (hub Builder sessions run the
    // MONOREPO executor suite against the same name on the same server) and
    // concurrent runs used to drop each other's schema mid-file.
    fileParallelism: false,
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    // Job worktrees under data/ are full clones of the repos jobs ran on —
    // they contain the clone's OWN test suites (which need deps this
    // package does not install). Sweep leftovers would otherwise be
    // crawled by every `npm test`. `scripts/` is excluded because the
    // installer's suites are node:test files (run them with
    // `make test-install` = `node --test scripts/`) — vitest finds no
    // suite in them and fails the file. (Setting `exclude` replaces
    // vitest's defaults, so node_modules/dist are repeated explicitly.)
    exclude: ['**/node_modules/**', '**/dist/**', 'data/**', 'scripts/**'],
  },
});
