/**
 * Test-environment guard, run by vitest before every test file loads.
 *
 * Suites hit real Postgres — they create and clear real tables — so a run
 * pointed at a live executor database destroys or pollutes real jobs. (The
 * hub's 2026-09-30 incident, where an e2e run without DATABASE_URL fell
 * back to the live Nexus database and parked six live executions, is why
 * this guard exists. Adapted from the hub's own vitest.setup.ts.)
 *
 * Rules, enforced before any test code executes:
 *  - DATABASE_URL unset → default to the dedicated `nexus_executor_test`.
 *  - DATABASE_URL set   → the database name must end in `test` or `_test`,
 *    otherwise the whole run refuses to start.
 */
const DEFAULT_TEST_URL = 'postgres://nexus:nexus@localhost:5544/nexus_executor_test';

function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`DATABASE_URL is not a valid postgres URL: ${url}`);
  }
}

const url = process.env.DATABASE_URL?.trim() || DEFAULT_TEST_URL;
const name = databaseName(url);
if (!/(^|_)test$/.test(name)) {
  throw new Error(
    `Refusing to run tests against database "${name}" — test suites create and clear real tables. ` +
      `Use a dedicated test database: DATABASE_URL=${DEFAULT_TEST_URL} npm test`,
  );
}
process.env.DATABASE_URL = url;
