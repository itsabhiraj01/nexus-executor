import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, databasePlan, discoverPostgres, initialize, pgEnvironment, provision, restore, sourceId } from './database.mjs';

test('fresh database gets a random password; configured databases require an explicit opt-in', () => {
  const plan = databasePlan({ existingEnv: false });
  assert.match(plan.url, /nexus_executor:[a-f0-9]{64}@127\.0\.0\.1:5556/);
  assert.equal(plan.source, null);
  assert.throws(() => databasePlan({ existingEnv: true, currentUrl: 'postgres://old/db' }), /will not be replaced/);
  assert.equal(databasePlan({ existingEnv: true, currentUrl: 'postgres://old/db', migrate: true }).source, 'postgres://old/db');
  assert.equal(databasePlan({ existingEnv: true, currentUrl: 'postgres://old/db', external: true }).url, 'postgres://old/db');
  assert.equal(databasePlan({ existingEnv: true, currentUrl: plan.url, previousUrl: plan.url }).url, plan.url);
  assert.throws(() => databasePlan({ external: true, migrate: true, currentUrl: 'postgres://old/db' }), /cannot be combined/);
});

test('PostgreSQL tools receive passwords in environment, not connection URLs in argv', () => {
  const env = pgEnvironment('postgres://user:secret%40password@127.0.0.1:5544/executor');
  assert.equal(env.PGPASSWORD, 'secret@password');
  assert.equal(env.PGPORT, '5544');
  assert.equal(env.PGHOST, '127.0.0.1');
  assert.equal(env.PGSERVICE, undefined);
  assert.equal(env.PGSERVICEFILE, undefined);
  assert.throws(() => pgEnvironment('postgres://user:secret@host/db?sslmode=require'), /query options/);
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-database-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = { pgBin: dir, dataDir: join(dir, 'data'), backupDir: join(dir, 'backups'), envFile: join(dir, '.env'), superuser: 'agent', port: 5556 };
  mkdirSync(settings.dataDir);
  writeFileSync(settings.envFile, 'DATABASE_URL=postgres://user:secret@localhost:5544/executor\n');
  writeFileSync(join(dir, 'pg_dump'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --file ]; then shift; printf archive > "$1"; fi; shift; done\n', { mode: 0o755 });
  writeFileSync(join(dir, 'pg_restore'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(dir, 'restore-args')}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'postgres'), '#!/bin/sh\necho "postgres (PostgreSQL) 16.4"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'initdb'), `#!/bin/sh\nprintf '%s\\n' init >> '${join(dir, 'init-events')}'\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -D ]; then shift; printf '16\\n' > "$1/PG_VERSION"; fi; shift; done\n`, { mode: 0o755 });
  const connect = async (_options, task) => task({ query: async sql => sql === 'SHOW server_version' ? { rows: [{ server_version: '16.4' }] } : { rowCount: 0 } });
  return { dir, settings, connect };
}

test('backup is private and verified; restore is transactional, non-destructive, and retry-safe', async t => {
  const f = fixture(t);
  const source = 'postgres://user:secret@localhost:5544/executor';
  const archive = await backup(f.settings, source, f.connect);
  assert.equal(statSync(archive).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(join(archive, '../manifest.json'), 'utf8'));
  assert.equal(manifest.sha256, sourceId(Buffer.from('archive')));
  assert.equal(readFileSync(join(archive, '../source.env'), 'utf8'), readFileSync(f.settings.envFile, 'utf8'));
  const target = 'postgres://user:new-password@127.0.0.1:5556/executor';
  await restore(f.settings, target, archive, sourceId(source), f.connect);
  const commands = readFileSync(join(f.dir, 'restore-args'), 'utf8');
  assert.match(commands, /--single-transaction --exit-on-error --no-owner --no-acl/);
  assert.doesNotMatch(commands, /secret|new-password|--clean/);
  await restore(f.settings, target, archive, sourceId(source), f.connect);
  assert.equal(readFileSync(join(f.dir, 'restore-args'), 'utf8'), commands);
  await assert.rejects(restore(f.settings, target, archive, 'another-source', f.connect), /different source/);
});

test('refuse tampered archives and nonempty targets', async t => {
  const f = fixture(t);
  const source = 'postgres://user:secret@localhost:5544/executor';
  const archive = await backup(f.settings, source, f.connect);
  const target = 'postgres://user:new-password@127.0.0.1:5556/executor';
  const nonempty = async (_options, task) => task({ query: async () => ({ rowCount: 1 }) });
  await assert.rejects(restore(f.settings, target, archive, sourceId(source), nonempty), /not empty/);
  writeFileSync(archive, 'tampered');
  await assert.rejects(restore(f.settings, target, archive, sourceId(source), f.connect), /checksum/);
});

test('never initialize over unknown or partial PostgreSQL data', t => {
  const f = fixture(t);
  writeFileSync(join(f.settings.dataDir, 'important-data'), 'preserve');
  assert.throws(() => initialize(f.settings), /nonempty/);
  writeFileSync(join(f.settings.dataDir, 'PG_VERSION'), '16\n');
  assert.throws(() => initialize(f.settings), /unrecognized/);
  assert.equal(readFileSync(join(f.settings.dataDir, 'important-data'), 'utf8'), 'preserve');
});

test('native initialization is idempotent and refuses implicit PostgreSQL major upgrades', t => {
  const f = fixture(t);
  initialize(f.settings);
  writeFileSync(join(f.settings.dataDir, 'important-data'), 'preserve');
  initialize(f.settings);
  assert.equal(readFileSync(join(f.dir, 'init-events'), 'utf8'), 'init\n');
  writeFileSync(join(f.dir, 'postgres'), '#!/bin/sh\necho "postgres (PostgreSQL) 17.2"\n', { mode: 0o755 });
  assert.throws(() => initialize(f.settings), /major upgrade/);
  assert.equal(readFileSync(join(f.settings.dataDir, 'important-data'), 'utf8'), 'preserve');
});

test('provisioning reuses the existing owner and never resets its password', async t => {
  const f = fixture(t);
  const queries = [];
  const connect = async (_options, task) => task({ query: async sql => {
    queries.push(sql);
    return { rowCount: 1, rows: [{ owner: 'nexus_executor' }] };
  } });
  await provision(f.settings, 'postgres://nexus_executor:password@127.0.0.1:5556/nexus_executor', connect);
  assert.doesNotMatch(queries.join('\n'), /ALTER|CREATE|PASSWORD/);
});

test('failed restore is not marked complete', async t => {
  const f = fixture(t);
  const source = 'postgres://user:secret@localhost:5544/executor';
  const archive = await backup(f.settings, source, f.connect);
  writeFileSync(join(f.dir, 'pg_restore'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(restore(f.settings, 'postgres://user:password@127.0.0.1:5556/executor', archive, sourceId(source), f.connect));
  assert.equal(existsSync(join(f.settings.dataDir, 'nexus-restore.json')), false);
});

test('PostgreSQL discovery pins real tool paths instead of a mutable package profile', t => {
  const f = fixture(t);
  const profile = join(f.dir, 'profile-bin');
  mkdirSync(profile);
  for (const name of ['postgres', 'initdb', 'pg_dump', 'pg_restore']) symlinkSync(join(f.dir, name), join(profile, name));
  assert.equal(discoverPostgres(profile), f.dir);
});
