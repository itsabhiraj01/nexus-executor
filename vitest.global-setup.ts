import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

/**
 * Per-run test databases — the run-level half of the test-database guard
 * (vitest.setup.ts is the per-worker validator).
 *
 * Problem this solves: every suite hits real Postgres, and parallel test runs
 * (several Builder executions verifying on the same box, a pipeline `npm test`
 * spawned beside a session's local run) used to share one `nexus_test`
 * database. The builder worker is deliberately deployment-wide — its tick
 * polls, chains and queue-promotes *every* active execution in the database —
 * so two concurrent suites raced the same rows: a chain start hit "This
 * subtask already has an execution in progress", a queued test-stage
 * promotion hit "Cannot move an execution from waiting_for_user to
 * verifying", and those CONFLICTs landed in the e2e's shared `workerErrors`
 * array, poisoning every later assertion (2026-10-02: the pipeline failed
 * 10/19 builder-opencode cases against code that passes 19/19 in isolation;
 * reproduced only while a parallel session's suite had live builder data in
 * the shared database).
 *
 * Fix: each `vitest run` gets its own private database on the same server.
 * DATABASE_URL (or the nexus_test default) is only the *template* — its
 * host/port/credentials are reused, its name is not. The run database is
 * created here, before any worker forks, and `DATABASE_URL` is repointed at
 * it so every forked worker inherits the private URL. It is dropped when the
 * run finishes (best effort; WITH (FORCE) reaps leaked pool connections).
 *
 * Failure modes are deliberately soft: if the maintenance database cannot be
 * reached or CREATE DATABASE fails, the run falls back to the shared URL
 * (exactly the old behavior) with a loud warning — a broken isolation layer
 * must never break the suite itself. vitest.setup.ts still refuses to run
 * against any database whose name does not end in `test`/`_test`, including
 * the generated ones (they always do).
 *
 * Orphaned run databases (a run killed with SIGKILL never reaches its
 * teardown) are swept at startup: databases matching the reserved
 * `nexus_executor_run_<epoch>_<rand>_test` shape that are older than 24h and have no
 * connections are dropped. The sweep only runs when the connecting role is a
 * superuser — otherwise pg_stat_activity hides other roles' connections and
 * "zero connections" could be a lie. A live watch session older than 24h
 * with idle pools would be misjudged as an orphan; that is the accepted
 * tradeoff (restart vitest to recover) for never accumulating garbage.
 */

const DEFAULT_TEST_URL = 'postgres://nexus:nexus@localhost:5544/nexus_executor_test';
const RUN_DB_PREFIX = 'nexus_executor_run_';
const RUN_DB_TTL_MS = 24 * 60 * 60 * 1000;

function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`DATABASE_URL is not a valid postgres URL: ${url}`);
  }
}

/** Same URL, same server, different database name. */
function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/** Generated names are `[a-z0-9_]+` only — safe to interpolate quoted. */
function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Refusing to quote unsafe identifier: ${name}`);
  return `"${name}"`;
}

function isRunDatabase(name: string): { stamp: number } | null {
  const match = /^nexus_executor_run_([0-9a-z]+)_[0-9a-z]+_test$/.exec(name);
  if (!match) return null;
  const stamp = Number.parseInt(match[1]!, 36);
  return Number.isFinite(stamp) ? { stamp } : null;
}

async function connectMaintenance(template: string, templateName: string): Promise<Client | null> {
  // The maintenance database is where CREATE DATABASE runs. `postgres` is the
  // standard one; fall back to the template URL's own database for servers
  // that do not have it.
  for (const name of ['postgres', templateName]) {
    const client = new Client({ connectionString: withDatabase(template, name) });
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => {});
    }
  }
  return null;
}

async function sweepOrphans(admin: Client): Promise<void> {
  const superuser = await admin
    .query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
    .then((result) => result.rows[0]?.rolsuper === true)
    .catch(() => false);
  if (!superuser) return;
  const databases = await admin
    .query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE '${RUN_DB_PREFIX}%_test'`,
    )
    .then((result) => result.rows.map((row) => row.datname));
  const now = Date.now();
  for (const name of databases) {
    const parsed = isRunDatabase(name);
    if (!parsed || now - parsed.stamp < RUN_DB_TTL_MS) continue;
    const connections = await admin
      .query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1', [name])
      .then((result) => Number(result.rows[0]?.count ?? '0'))
      .catch(() => 1); // cannot tell — assume it is busy and leave it alone
    if (connections > 0) continue;
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`).catch(() => {});
  }
}

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  const template = process.env.DATABASE_URL?.trim() || DEFAULT_TEST_URL;
  const templateName = databaseName(template);
  // A non-test URL is left untouched: vitest.setup.ts refuses it loudly per
  // file, exactly as before. Never derive anything from a live-database URL.
  if (!/(^|_)test$/.test(templateName)) return;

  const admin = await connectMaintenance(template, templateName);
  if (!admin) {
    console.warn(
      `[nexus] Could not reach a maintenance database on the test server — ` +
        `falling back to the shared ${templateName} database. Concurrent test runs ` +
        `may interfere with each other (see vitest.global-setup.ts).`,
    );
    return;
  }

  const runName = `${RUN_DB_PREFIX}${Date.now().toString(36)}_${randomBytes(4).toString('hex')}_test`;
  try {
    await sweepOrphans(admin);
    await admin.query(`CREATE DATABASE ${quoteIdent(runName)}`);
  } catch (error) {
    await admin.end().catch(() => {});
    console.warn(
      `[nexus] Could not create a private test database (${String(error)}) — ` +
        `falling back to the shared ${templateName} database.`,
    );
    return;
  }

  const runUrl = withDatabase(template, runName);
  process.env.DATABASE_URL = runUrl;

  return async () => {
    const dropper = new Client({ connectionString: withDatabase(template, 'postgres') });
    try {
      await dropper.connect();
      await dropper.query(`DROP DATABASE IF EXISTS ${quoteIdent(runName)} WITH (FORCE)`);
    } catch {
      // Best effort — an orphan is swept by a later run (see sweepOrphans).
    } finally {
      await dropper.end().catch(() => {});
    }
    await admin.end().catch(() => {});
  };
}
