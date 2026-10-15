import { Pool, type QueryResult } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/**
 * Postgres-backed checkpointing (spec §Integration seams §State and plan
 * Task 6): each JOB (later: each execution) gets its own checkpoint schema
 * so cleanup is one DROP and no executor run can read another job's state.
 * `createCheckpointer` creates the schema, points a PostgresSaver at it and
 * runs `setup()` (idempotent DDL).
 *
 * The schema name is interpolated into DDL, so it is restricted to a plain
 * identifier — callers build it from executor-side ids, never from
 * hub-supplied free text.
 */

export interface HarnessCheckpointer {
  readonly saver: PostgresSaver;
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

export async function createCheckpointer(databaseUrl: string, schema: string): Promise<HarnessCheckpointer> {
  if (!IDENTIFIER.test(schema)) {
    throw new Error(`Checkpoint schema must be a plain identifier, got ${JSON.stringify(schema)}`);
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const saver = new PostgresSaver(pool, undefined, { schema });
  await saver.setup();
  return {
    saver,
    query: (text, params) => pool.query(text, params as never[] | undefined),
    close: () => pool.end(),
  };
}
