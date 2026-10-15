import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, defaultMigrationsDir, runModuleMigrations } from './db.js';
import { TerminalStore, type TmuxSessionIdentity } from './terminal-store.js';

/**
 * The durable terminal registry against REAL Postgres: the upsert's
 * concurrency claims (one row per tmux-native identity — simultaneous
 * reconciles cannot duplicate a registration), rename/exit semantics, and
 * cross-instance (post-restart) recovery. Migration idempotency is covered
 * here too — the file owns the table it tests.
 */

let pool: Pool;
let store: TerminalStore;

const SERVER = '/tmp/tmux-1000/default#1791819000.4020501';
const SERVER_RESTARTED = '/tmp/tmux-1000/default#1791819999.4020666';

function identity(overrides: Partial<TmuxSessionIdentity> = {}): TmuxSessionIdentity {
  return {
    server: SERVER,
    sessionId: '$7',
    createdAt: new Date('2026-10-11T09:00:00.000Z'),
    ...overrides,
  };
}

function registered(overrides: Partial<Parameters<TerminalStore['upsertLive']>[0]> = {}) {
  return {
    identity: identity(),
    tmuxName: 'manual-dev',
    candidatePublicId: null,
    mintPublicId: () => 'nxt-mint01',
    origin: 'imported' as const,
    now: new Date('2026-10-12T10:00:00.000Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  await pool.query('DROP SCHEMA IF EXISTS executor CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS platform CASCADE');
  await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE executor.terminal_sessions');
  store = new TerminalStore(pool);
});

describe('terminal-store', () => {
  it('applies the migration idempotently (a reapplied 003 is a no-op)', async () => {
    const ran = await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
    expect(ran).toEqual([]);
    // And the table is still fully functional.
    const rec = await store.upsertLive(registered());
    expect(rec.publicId).toBe('nxt-mint01');
  });

  it('inserts a registration, minting a public id when none is preferred', async () => {
    const rec = await store.upsertLive(registered());
    expect(rec.publicId).toBe('nxt-mint01');
    expect(rec).toMatchObject({
      tmuxServer: SERVER, tmuxSessionId: '$7', tmuxName: 'manual-dev',
      name: 'manual-dev', origin: 'imported', exitedAt: null,
    });
    const read = await store.byPublicId('nxt-mint01');
    expect(read).toEqual(rec);
  });

  it('prefers the existing nxt-* identity on initial backfill', async () => {
    const rec = await store.upsertLive(registered({ tmuxName: 'nxt-abc123', candidatePublicId: 'nxt-abc123' }));
    expect(rec.publicId).toBe('nxt-abc123');
  });

  it('converges concurrent registrations of the same tmux identity onto ONE row', async () => {
    // Two reconciles from (hypothetical) racing processes registering the same
    // discovered session with different preferred/minted ids. The identity
    // triple is the arbiter: exactly one row, one winning public id.
    const results = await Promise.all(
      ['nxt-cand01', 'nxt-cand02', 'nxt-cand03'].map((candidate) =>
        new TerminalStore(pool).upsertLive(registered({ candidatePublicId: candidate }))),
    );
    expect(new Set(results.map((rec) => rec.publicId)).size).toBe(1);
    const { rows } = await pool.query('SELECT * FROM executor.terminal_sessions');
    expect(rows).toHaveLength(1);
    expect(results[0]!.publicId).toMatch(/^nxt-cand0[123]$/);
  });

  it('falls back to a minted id when the preferred public id belongs to a dead session', async () => {
    // A stale (exited) row still holds the old session's public id; the brand
    // NEW session that reused its tmux name must not adopt it — it mints.
    const stale = await store.upsertLive(registered({
      identity: identity({ sessionId: '$1' }), tmuxName: 'nxt-abc123', candidatePublicId: 'nxt-abc123',
    }));
    await store.markExited(stale.publicId, new Date());
    const rec = await store.upsertLive(registered({ tmuxName: 'nxt-abc123', candidatePublicId: 'nxt-abc123' }));
    expect(rec.publicId).toBe('nxt-mint01'); // mintPublicId fallback, not the occupied name
    const { rows } = await pool.query('SELECT * FROM executor.terminal_sessions ORDER BY public_id');
    expect(rows).toHaveLength(2);
  });

  it('gives up with TerminalStoreError when every minted id collides', async () => {
    await expect(
      store.upsertLive(registered({ mintPublicId: () => 'nxt-' + 'x'.repeat(6) }))
        .catch((error: unknown) => error),
    ).resolves.toMatchObject({ publicId: 'nxt-xxxxxx' });
    // Now occupy the row and force the same mint again.
    await store.markExited('nxt-xxxxxx', new Date());
    await expect(
      store.upsertLive(registered({ identity: identity({ sessionId: '$9' }), mintPublicId: () => 'nxt-' + 'x'.repeat(6) })),
    ).rejects.toMatchObject({ name: 'TerminalStoreError', message: expect.stringMatching(/collisions/) });
  });

  it('tracks tmux renames for imported sessions; created sessions keep their display name', async () => {
    const at = new Date('2026-10-12T10:00:00.000Z');
    await store.upsertLive(registered({ origin: 'imported', now: at }));
    const renamed = await store.upsertLive(registered({ tmuxName: 'maintenance', now: new Date(at.getTime() + 60_000) }));
    expect(renamed).toMatchObject({ tmuxName: 'maintenance', name: 'maintenance' });

    await store.upsertLive(registered({
      identity: identity({ sessionId: '$8' }),
      origin: 'created', tmuxName: 'nxt-own001', candidatePublicId: 'nxt-own001', displayName: 'dev box',
    }));
    const renamedCreated = await store.upsertLive(registered({
      identity: identity({ sessionId: '$8' }),
      origin: 'imported', tmuxName: 'operator-renamed', candidatePublicId: null,
    }));
    expect(renamedCreated).toMatchObject({ tmuxName: 'operator-renamed', name: 'dev box', origin: 'created' });
  });

  it('updates last_seen/last_active on re-registration and revives a wrongly-tombed row', async () => {
    const at = new Date('2026-10-12T10:00:00.000Z');
    const first = await store.upsertLive(registered({ now: at }));
    await store.markExited(first.publicId, at);
    const again = await store.upsertLive(registered({ now: new Date(at.getTime() + 120_000) }));
    expect(again.exitedAt).toBeNull();
    expect(again.lastSeenAt.getTime()).toBe(at.getTime() + 120_000);
  });

  it('markMissingExited stamps everything not in the keep set — server restart empties the board', async () => {
    const at = new Date('2026-10-12T10:00:00.000Z');
    const live = await store.upsertLive(registered({ identity: identity({ sessionId: '$1' }) }));
    const goneOldServer = await store.upsertLive(registered({
      identity: identity({ sessionId: '$2', server: SERVER_RESTARTED }),
      mintPublicId: () => 'nxt-old001',
    }));
    const earlier = await store.markMissingExited([goneOldServer.publicId], at);
    expect(earlier.map((r) => r.publicId)).toEqual([live.publicId]);
    // The sweep is idempotent: the second run transitions nothing.
    expect(await store.markMissingExited([goneOldServer.publicId], at)).toEqual([]);
    const revived = await store.upsertLive(registered({ identity: identity({ sessionId: '$3' }), mintPublicId: () => 'nxt-fresh1' }));
    // A fresh inventory on the restarted server: nothing from the old server survives.
    const swept = await store.markMissingExited([revived.publicId], new Date(at.getTime() + 60_000));
    expect(swept.map((r) => r.publicId).sort()).toEqual([goneOldServer.publicId]);
  });

  it('recentlyExited serves the 10-minute tombstone window, oldest first', async () => {
    const at = new Date('2026-10-12T10:00:00.000Z');
    const a = await store.upsertLive(registered({ identity: identity({ sessionId: '$1' }) }));
    const b = await store.upsertLive(registered({ identity: identity({ sessionId: '$2' }), mintPublicId: () => 'nxt-b00001' }));
    await store.markExited(a.publicId, new Date(at.getTime() + 1_000));
    await store.markExited(b.publicId, new Date(at.getTime() + 2_000));
    const recent = await store.recentlyExited(new Date(at.getTime() + 500));
    expect(recent.map((r) => r.publicId)).toEqual([a.publicId, b.publicId]);
    expect((await store.recentlyExited(new Date(at.getTime() + 1_500))).map((r) => r.publicId)).toEqual([b.publicId]);
    expect(await store.recentlyExited(new Date(at.getTime() + 3_000))).toEqual([]);
  });

  it('recovers registrations across store instances (executor restart recovery)', async () => {
    const first = new TerminalStore(pool);
    const rec = await first.upsertLive(registered());
    // A "restarted process" seeing nothing but the database.
    const rebooted = new TerminalStore(pool);
    expect(await rebooted.byPublicId(rec.publicId)).toEqual(rec);
    expect(await rebooted.byPublicId('nxt-nope00')).toBeNull();
  });

  it('persists last_active only for live rows', async () => {
    const rec = await store.upsertLive(registered());
    const active = new Date('2026-10-12T10:05:00.000Z');
    await store.setLastActive(rec.publicId, active);
    expect((await store.byPublicId(rec.publicId))!.lastActiveAt.getTime()).toBe(active.getTime());
    await store.markExited(rec.publicId, new Date());
    await store.setLastActive(rec.publicId, new Date('2026-10-12T10:06:00.000Z'));
    expect((await store.byPublicId(rec.publicId))!.lastActiveAt.getTime()).toBe(active.getTime());
  });
});
