import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/**
 * Postgres pool + the name-keyed migration runner (adapted from the hub's
 * `@nexus/db` migrate.ts, reduced to this executor's single module).
 *
 * Migrations are numbered SQL files, additive only. Each runs in its own
 * transaction with `SET LOCAL search_path = executor, public`, and applied
 * file names are recorded in `platform.schema_migrations` under the module
 * id `executor` — re-running is a no-op, and a recorded-but-missing file is
 * simply ignored.
 */

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

/** Anything that can run a query — a pool or a transaction client. */
export interface SqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS platform;
    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      module_id  TEXT NOT NULL,
      version    TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (module_id, version)
    );
  `);
}

export async function runModuleMigrations(
  pool: Pool,
  moduleId: string,
  schemaName: string,
  migrationsDir: string,
): Promise<string[]> {
  const schema = quoteIdent(schemaName);
  await ensureMigrationsTable(pool);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

  const applied = new Set(
    (
      await pool.query<{ version: string }>(
        `SELECT version FROM platform.schema_migrations WHERE module_id = $1`,
        [moduleId],
      )
    ).rows.map((row) => row.version),
  );

  const dir = resolve(migrationsDir);
  const MIGRATION_NAME = /^\d{3,}_[a-z0-9_]+\.sql$/;
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!MIGRATION_NAME.test(file)) {
      throw new Error(
        `Invalid migration filename ${JSON.stringify(file)} in ${dir}: ` +
          `must match /^\\d{3,}_[a-z0-9_]+\\.sql$/ (e.g. "001_init.sql").`,
      );
    }
  }

  const ran: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = await readFile(join(dir, file), 'utf8');
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path = ${schema}, public`);
      await client.query(sql);
      await client.query(
        `INSERT INTO platform.schema_migrations (module_id, version) VALUES ($1, $2)`,
        [moduleId, version],
      );
      await client.query('COMMIT');
      ran.push(version);
    } catch (error) {
      await client.query('ROLLBACK');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${moduleId}/${file} failed: ${message}`, { cause: error });
    } finally {
      client.release();
    }
  }
  return ran;
}

/** The directory migrations ship in — `<repo>/src/migrations` from both the
 *  sources (tsx) and the compiled output (`dist/main.js`). */
export function defaultMigrationsDir(): string {
  return new URL('../src/migrations', import.meta.url).pathname;
}
