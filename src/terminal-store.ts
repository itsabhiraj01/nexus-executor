import type { Pool } from 'pg';

/**
 * Durable terminal-session registrations (executor.terminal_sessions —
 * migration 003). The in-memory `TerminalRegistry` owns runtime state (pty
 * clients, ring buffers, parked readers); THIS store owns what must outlive
 * the process: the public `nxt-*` id ↔ tmux-native identity mapping, display
 * names, origin, and the live→exited transition.
 *
 * Identity is the (tmux_server, tmux_session_id, tmux_created_at) triple —
 * a tmux name is mutable (`rename-session`) and a bare `$N` is only unique
 * per server lifetime, so names never key anything and the creation stamp
 * pins the lifetime.
 */

export type TerminalOrigin = 'created' | 'imported';

export interface TmuxSessionIdentity {
  /** tmux server identity (socket path + server start time + pid). */
  server: string;
  /** tmux' own session id ("$N"): stable across renames within one server. */
  sessionId: string;
  /** tmux' session_created timestamp. */
  createdAt: Date;
}

export interface TerminalSessionRecord {
  publicId: string;
  tmuxServer: string;
  tmuxSessionId: string;
  tmuxCreatedAt: Date;
  tmuxName: string;
  name: string;
  origin: TerminalOrigin;
  createdAt: Date;
  lastActiveAt: Date;
  lastSeenAt: Date;
  exitedAt: Date | null;
}

/** A storage/discovery persistence failure — ops.ts maps it to 502. */
export class TerminalStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TerminalStoreError';
  }
}

interface Row {
  public_id: string;
  tmux_server: string;
  tmux_session_id: string;
  tmux_created_at: Date;
  tmux_name: string;
  name: string;
  origin: string;
  created_at: Date;
  last_active_at: Date;
  last_seen_at: Date;
  exited_at: Date | null;
}

function rowToRecord(row: Row): TerminalSessionRecord {
  return {
    publicId: row.public_id,
    tmuxServer: row.tmux_server,
    tmuxSessionId: row.tmux_session_id,
    tmuxCreatedAt: row.tmux_created_at,
    tmuxName: row.tmux_name,
    name: row.name,
    origin: row.origin === 'created' ? 'created' : 'imported',
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    lastSeenAt: row.last_seen_at,
    exitedAt: row.exited_at,
  };
}

export interface RegisterDiscoveredInput {
  identity: TmuxSessionIdentity;
  /** The tmux session name as read in the current inventory. */
  tmuxName: string;
  /** Preferred public id (an existing registry-facing `nxt-*` name); null
   *  = the store mints via `mintPublicId`. */
  candidatePublicId: string | null;
  mintPublicId: () => string;
  /**
   * 'created': the executor minted the session (display name may differ from
   * the tmux name and never tracks renames). 'imported': backfilled from an
   * operator-made session (display name follows tmux renames). Origin only
   * applies on INSERT — an existing row never flips.
   */
  origin: TerminalOrigin;
  /** Display name for a fresh registration (created sessions only; imports
   *  always display the tmux name). */
  displayName?: string;
  /** Activity stamp (create/attach). */
  lastActiveAt?: Date;
  now: Date;
}

const PUBLIC_ID_ATTEMPTS = 5;

function isPublicIdConflict(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'terminal_sessions_pkey';
}

export class TerminalStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert-or-reconcile one session seen live in a tmux inventory. The
   * (server, session id, created) uniqueness makes concurrent registrations
   * converge on ONE row (and one public id): the first insert wins, others
   * fall into the ON CONFLICT branch. A collision on the preferred public id
   * (a stale row from a dead session) retries with a fresh minted id — the
   * dead row is left for the mark-missing sweep.
   */
  async upsertLive(input: RegisterDiscoveredInput): Promise<TerminalSessionRecord> {
    let candidate = input.candidatePublicId ?? input.mintPublicId();
    for (let attempt = 1; attempt <= PUBLIC_ID_ATTEMPTS; attempt += 1) {
      try {
        const { rows } = await this.pool.query<Row>(
          `INSERT INTO executor.terminal_sessions
             (public_id, tmux_server, tmux_session_id, tmux_created_at, tmux_name, name, origin,
              created_at, last_active_at, last_seen_at, exited_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, NULL)
           ON CONFLICT (tmux_server, tmux_session_id, tmux_created_at) DO UPDATE SET
             tmux_name = EXCLUDED.tmux_name,
             -- Imported sessions follow tmux renames; created ones keep the
             -- display name the console chose at creation.
             name = CASE WHEN terminal_sessions.origin = 'imported'
                         THEN EXCLUDED.tmux_name ELSE terminal_sessions.name END,
             last_seen_at = EXCLUDED.last_seen_at,
             last_active_at = GREATEST(terminal_sessions.last_active_at, EXCLUDED.last_active_at),
             exited_at = NULL
           RETURNING *`,
          [
            candidate,
            input.identity.server,
            input.identity.sessionId,
            input.identity.createdAt,
            input.tmuxName,
            input.origin === 'imported' ? input.tmuxName : (input.displayName ?? input.tmuxName),
            input.origin,
            input.now,
            input.lastActiveAt ?? input.now,
          ],
        );
        return rowToRecord(rows[0]!);
      } catch (error) {
        if (isPublicIdConflict(error)) {
          candidate = input.mintPublicId();
          continue;
        }
        if (error instanceof TerminalStoreError) throw error;
        throw new TerminalStoreError(
          `terminal session registration failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    throw new TerminalStoreError('could not allocate a public terminal session id (repeated collisions)');
  }

  /** The durable row for a public id (any state, live or exited). */
  async byPublicId(publicId: string): Promise<TerminalSessionRecord | null> {
    try {
      const { rows } = await this.pool.query<Row>(
        `SELECT * FROM executor.terminal_sessions WHERE public_id = $1`,
        [publicId],
      );
      return rows[0] ? rowToRecord(rows[0]) : null;
    } catch (error) {
      throw new TerminalStoreError(
        `terminal session lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** Stamp one session as exited (idempotent — a restamp is a no-op). */
  async markExited(publicId: string, at: Date): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE executor.terminal_sessions SET exited_at = $2 WHERE public_id = $1 AND exited_at IS NULL`,
        [publicId, at],
      );
    } catch (error) {
      throw new TerminalStoreError(
        `terminal session exit stamp failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * One successful inventory says everything not in `keepPublicIds` is gone:
   * stamp those rows exited. Returns the records that transitioned THIS call
   * (the registry mirrors them into in-memory tombstones so parked readers
   * resolve eof and a 404'd id stays understandable).
   */
  async markMissingExited(keepPublicIds: string[], at: Date): Promise<TerminalSessionRecord[]> {
    try {
      const { rows } = await this.pool.query<Row>(
        `UPDATE executor.terminal_sessions SET exited_at = $2
         WHERE exited_at IS NULL AND NOT (public_id = ANY($1::text[]))
         RETURNING *`,
        [keepPublicIds, at],
      );
      return rows.map(rowToRecord);
    } catch (error) {
      throw new TerminalStoreError(
        `terminal session sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** The last-known-active stamp (throttled writes from the registry). */
  async setLastActive(publicId: string, at: Date): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE executor.terminal_sessions SET last_active_at = $2 WHERE public_id = $1 AND exited_at IS NULL`,
        [publicId, at],
      );
    } catch (error) {
      throw new TerminalStoreError(
        `terminal session activity stamp failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** Rows that exited at/after `since` — the cross-restart tombstone view. */
  async recentlyExited(since: Date): Promise<TerminalSessionRecord[]> {
    try {
      const { rows } = await this.pool.query<Row>(
        `SELECT * FROM executor.terminal_sessions
         WHERE exited_at IS NOT NULL AND exited_at >= $1
         ORDER BY exited_at ASC`,
        [since],
      );
      return rows.map(rowToRecord);
    } catch (error) {
      throw new TerminalStoreError(
        `terminal tombstone read failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
