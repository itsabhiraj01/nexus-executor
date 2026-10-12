import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { credentials, dotenv, environment, options, quote, repository, systemdEnvironment, units } from './install.mjs';
import { waitFor } from './runtime.mjs';

test('password generation and reuse, without silently replacing credentials', () => {
  const fresh = credentials({}, {});
  assert.match(fresh.password, /^[a-f0-9]{64}$/);
  assert.equal(credentials({ OPENCODE_TOKEN: 'existing' }, {}).password, 'existing');
  assert.equal(credentials({}, { OPENCODE_SERVER_PASSWORD: 'existing' }).password, 'existing');
  assert.throws(() => credentials({ OPENCODE_TOKEN: 'different' }, { OPENCODE_SERVER_PASSWORD: 'existing' }), /differs/);
  assert.throws(() => credentials({ OPENCODE_TOKEN: 'Bearer secret' }, {}), /plain password/);
  assert.throws(() => credentials({ OPENCODE_BASE_URL: 'http://remote:4096' }, {}), /Managed OpenCode/);
});

test('strict options and safe environment/unit generation', () => {
  assert.equal(options(['--code', 'ABC']).pair, true);
  assert.throws(() => options(['--code']), /Missing value/);
  assert.throws(() => options(['--db-port', '1']), /1024 and 65535/);
  assert.throws(() => environment({ SECRET: 'a\nb' }), /multiline/);
  assert.equal(environment({ SECRET: 'a"b\\c$' }), 'SECRET="a\\"b\\\\c$"\n');
  assert.equal(systemdEnvironment(environment({ SECRET: 'a"b\\c$' })).SECRET, 'a"b\\c$');
  assert.equal(parseEnv(dotenv({ SECRET: 'a"b\\c$' })).SECRET, 'a"b\\c$');
  assert.equal(quote('/path% with space'), '"/path%% with space"');
  const database = { pgBin: '/postgres', dataDir: '/data', socketDir: '/socket', port: 5556 };
  const generated = units({ root: '/repo with spaces', config: '/config', node: '/node', opencode: '/opencode', database, path: '/bin', externalDb: false });
  assert.match(generated['nexus-executor.service'], /Requires=nexus-db.service/);
  assert.match(generated['nexus-executor.service'], /--migrate-only/);
  assert.match(generated['opencode-executor.service'], /opencode.env/);
  assert.match(generated['nexus-db.service'], /"\/postgres\/postgres" "-D" "\/data"/);
  assert.doesNotMatch(generated['nexus-db.service'], /compose|podman|docker/);
  const external = units({ root: '/repo', config: '/config', node: '/node', opencode: '/opencode', path: '/bin', externalDb: true });
  assert.equal(external['nexus-db.service'], undefined);
  assert.doesNotMatch(external['nexus-executor.service'], /Requires=/);
});

test('readiness propagates failures instead of reporting success', async () => {
  await waitFor(async () => {}, 'test', 1);
  await assert.rejects(waitFor(async () => { throw new Error('secret'); }, 'test', 1), /test did not become ready/);
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-install-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['scripts', 'dist', 'bin', 'mocks', 'home', '.git']) mkdirSync(join(dir, name));
  copyFileSync(join(repository, 'scripts/install.mjs'), join(dir, 'scripts/install.mjs'));
  const databaseModule = pathToFileURL(join(repository, 'scripts/database.mjs')).href;
  writeFileSync(join(dir, 'scripts/database.mjs'), `
    export { databasePlan, discoverPostgres, sourceId, privateFile } from ${JSON.stringify(databaseModule)};
    import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    if (import.meta.url === pathToFileURL(process.argv[1]).href) {
      const action = process.argv[2];
      appendFileSync(process.env.EVENTS, 'database ' + action + '\\n');
      const settings = JSON.parse(readFileSync(process.argv[3], 'utf8'));
      if (action === 'init') mkdirSync(settings.dataDir, {recursive:true});
      if (action === 'backup') {
        if (process.env.FAIL_BACKUP) process.exit(1);
        mkdirSync(settings.backupDir, {recursive:true});
        const archive = join(settings.backupDir, 'test.dump');
        writeFileSync(archive, 'test archive');
        console.log(archive);
      }
      if (action === 'restore' && process.env.FAIL_RESTORE) process.exit(1);
    }
  `);
  writeFileSync(join(dir, '.env.example'), 'DATABASE_URL=postgres://nexus_executor:nexus_executor@localhost:5555/nexus_executor\nCUSTOM_SETTING=keep-me\n');
  writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(dir, 'scripts/runtime.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.EVENTS, 'ready ' + process.argv[2] + '\\n');`);
  writeFileSync(join(dir, 'dist/main.js'), `const fs = require('fs'); fs.appendFileSync(process.env.EVENTS, 'migrate\\n'); if (process.env.FAIL_MIGRATION) process.exit(1);`);
  writeFileSync(join(dir, 'bin/nexus-executor'), `const fs = require('fs'); fs.appendFileSync(process.env.EVENTS, 'pair\\n');`);
  for (const name of ['npm', 'git', 'systemctl', 'loginctl', 'opencode', 'postgres', 'initdb', 'pg_dump', 'pg_restore', 'tmux', 'python3', 'make', 'c++']) {
    const script = `#!/bin/sh\nprintf '%s\\n' '${name}'" $*" >> "$EVENTS"\n` +
      (name === 'systemctl' ? 'case "$*" in *LoadState*) echo "${UNIT_LOAD_STATE:-not-found}";; esac\n' : '') +
      (name === 'git' ? 'case "$*" in *status*) printf %s "$DIRTY";; esac\n' : '');
    writeFileSync(join(dir, 'mocks', name), script, { mode: 0o755 });
  }
  const events = join(dir, 'events');
  const env = { ...process.env, HOME: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'home/.config'), XDG_DATA_HOME: join(dir, 'home/.local/share'), PATH: join(dir, 'mocks') + ':' + process.env.PATH, EVENTS: events };
  delete env.DATABASE_URL;
  const run = (args = [], extra = {}) => spawnSync(process.execPath, [join(dir, 'scripts/install.mjs'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const log = () => readFileSync(events, 'utf8');
  return { dir, run, log, env };
}

test('first install and repeated update preserve secrets, pair only on request, and deploy in order', t => {
  const f = fixture(t);
  const first = f.run(['--no-pull', '--gateway', 'https://gateway.example', '--code', 'ABC']);
  assert.equal(first.status, 0, first.stderr);
  const config = join(f.dir, 'home/.config/nexus-executor');
  const password = parseEnv(readFileSync(join(config, 'opencode.env'), 'utf8')).OPENCODE_SERVER_PASSWORD;
  assert.equal(parseEnv(readFileSync(join(config, 'executor.env'), 'utf8')).OPENCODE_TOKEN, password);
  assert.equal(parseEnv(readFileSync(join(f.dir, '.env'), 'utf8')).OPENCODE_TOKEN, password);
  assert.equal(statSync(join(config, 'executor.env')).mode & 0o777, 0o600);
  assert.equal(statSync(join(config, 'opencode.env')).mode & 0o777, 0o600);
  assert.doesNotMatch(first.stdout + first.stderr + f.log(), new RegExp(password));
  const events = f.log();
  assert.ok(events.indexOf('npm run build') < events.indexOf('migrate'));
  assert.ok(events.indexOf('ready db') < events.indexOf('migrate'));
  assert.ok(events.indexOf('database backup') < events.indexOf('migrate'));
  assert.ok(events.indexOf('migrate') < events.indexOf('pair'));
  assert.ok(events.indexOf('pair') < events.indexOf('restart opencode-executor.service'));
  assert.match(events, /loginctl enable-linger/);
  const second = f.run([], { UNIT_LOAD_STATE: 'loaded' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(f.log(), /git pull --ff-only/);
  assert.match(f.log(), /stop nexus-executor.service/);
  assert.equal(f.log().split('\n').filter(line => line === 'pair').length, 1);
  assert.equal(parseEnv(readFileSync(join(config, 'opencode.env'), 'utf8')).OPENCODE_SERVER_PASSWORD, password);
  assert.equal(parseEnv(readFileSync(join(f.dir, '.env'), 'utf8')).CUSTOM_SETTING, 'keep-me');
});

test('failed migration does not restart services', t => {
  const f = fixture(t);
  const result = f.run(['--no-pull'], { FAIL_MIGRATION: '1' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(f.log(), /restart (?:opencode|nexus)-executor.service/);
});

test('dirty checkout fails before pull/build; dry-run makes no changes', t => {
  const f = fixture(t);
  assert.notEqual(f.run([], { DIRTY: ' M file' }).status, 0);
  assert.doesNotMatch(f.log(), /git pull|npm ci/);
  const before = f.log();
  assert.equal(f.run(['--dry-run']).status, 0);
  assert.equal(f.log(), before);
});

test('external database is backed up without starting a managed service', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, '.env'), 'DATABASE_URL=postgres://user:pass@remote:5432/custom\n');
  assert.notEqual(f.run(['--no-pull']).status, 0);
  const result = f.run(['--no-pull', '--external-db']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.log(), /database backup/);
  assert.doesNotMatch(f.log(), /database init|database provision|start nexus-db/);
});

test('existing database requires explicit migration; source is backed up before native initialization', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, '.env'), 'DATABASE_URL=postgres://user:pass@localhost:5544/executor\n');
  assert.notEqual(f.run(['--no-pull']).status, 0);
  const result = f.run(['--no-pull', '--migrate-db']);
  assert.equal(result.status, 0, result.stderr);
  const events = f.log();
  assert.ok(events.indexOf('database backup') < events.indexOf('database init'));
  assert.ok(events.indexOf('database restore') < events.indexOf('migrate'));
  assert.match(parseEnv(readFileSync(join(f.dir, '.env'), 'utf8')).DATABASE_URL, /127\.0\.0\.1:5556/);
  assert.doesNotMatch(events, /docker|podman|DROP|--clean/);
});

for (const failure of ['FAIL_BACKUP', 'FAIL_RESTORE', 'FAIL_MIGRATION']) {
  test(`${failure} preserves source configuration and does not restart applications`, t => {
    const f = fixture(t);
    const original = 'DATABASE_URL=postgres://user:pass@localhost:5544/executor\n';
    writeFileSync(join(f.dir, '.env'), original);
    const result = f.run(['--no-pull', '--migrate-db'], { [failure]: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(f.dir, '.env'), 'utf8'), original);
    assert.doesNotMatch(f.log(), /restart (?:opencode|nexus)-executor.service/);
    if (failure === 'FAIL_BACKUP') assert.doesNotMatch(f.log(), /database init/);
  });
}

test('generated unit syntax passes systemd verification without ignored settings', t => {
  const available = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  if (available.status !== 0) return t.skip('systemd-analyze unavailable');
  const f = fixture(t);
  const config = join(f.dir, 'home/.config/nexus-executor');
  const database = { pgBin: join(f.dir, 'mocks'), dataDir: f.dir, socketDir: f.dir, port: 5556 };
  const generated = units({ root: f.dir, config, node: process.execPath, opencode: join(f.dir, 'mocks/opencode'), database, path: f.env.PATH, externalDb: false });
  const files = Object.entries(generated).map(([name, content]) => {
    const file = join(f.dir, name);
    writeFileSync(file, content);
    return file;
  });
  const result = spawnSync('systemd-analyze', ['--user', 'verify', ...files], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ignoring:|fatal error|not absolute/);
});
