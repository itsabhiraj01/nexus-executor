import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { databasePlan, discoverPostgres, sourceId, privateFile } from './database.mjs';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let servicesTouched = false;

export function options(args) {
  const result = { pull: true, pair: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--no-pull') result.pull = false;
    else if (flag === '--dry-run') result.dryRun = true;
    else if (flag === '--pair') result.pair = true;
    else if (flag === '--external-db') result.externalDb = true;
    else if (flag === '--migrate-db') result.migrateDb = true;
    else if (flag === '--help') result.help = true;
    else if (['--gateway', '--code', '--postgres-bin', '--db-port', '--backup-dir'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      result[flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (result['db-port'] && (!/^\d+$/.test(result['db-port']) || Number(result['db-port']) < 1024 || Number(result['db-port']) > 65535)) {
    throw new Error('--db-port must be between 1024 and 65535');
  }
  if (result.code) result.pair = true;
  if (result.gateway && !result.pair) throw new Error('--gateway requires --code or --pair');
  return result;
}

export function systemdEnvironment(text) {
  const values = parseEnv(text);
  // Node's dotenv parser does not understand escaped quotes in systemd double quotes.
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"\s*$/);
    if (match) values[match[1]] = match[2].replace(/\\([\\"`$])/g, '$1');
  }
  return values;
}
function readEnv(path) { return existsSync(path) ? systemdEnvironment(readFileSync(path, 'utf8')) : {}; }
export function dotenv(values) {
  return Object.entries(values).map(([key, value]) => {
    const delimiter = ["'", '"', '`'].find(char => !value.includes(char));
    if (!delimiter || /[\r\n\0]/.test(value)) throw new Error(`Cannot safely encode ${key} in .env`);
    return `${key}=${delimiter}${value}${delimiter}`;
  }).join('\n') + '\n';
}
// systemd's EnvironmentFile format (not a shell script). Never interpolate secrets into units.
export function environment(values) {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) {
      throw new Error(`Unsupported multiline or invalid environment entry: ${key}`);
    }
    return `${key}="${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }).join('\n') + '\n';
}

export function credentials(env, previous) {
  const url = env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096';
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || parsed.port !== '4096' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('Managed OpenCode requires OPENCODE_BASE_URL=http://127.0.0.1:4096 (or localhost)');
  }
  const password = previous.OPENCODE_SERVER_PASSWORD || env.OPENCODE_TOKEN || randomBytes(32).toString('hex');
  if (/^(Basic|Bearer)\s/i.test(password)) throw new Error('Managed OpenCode needs a plain password, not an auth scheme');
  if (env.OPENCODE_TOKEN && env.OPENCODE_TOKEN !== password) {
    throw new Error('OPENCODE_TOKEN differs from the existing opencode.env password; reconcile them before installing');
  }
  return { password, url: url.replace(/\/$/, '') };
}

// Escape systemd specifiers as well as quoted command/path syntax.
export function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid systemd path');
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
const command = (...args) => args.map(value => quote(value).replaceAll('$', '$$')).join(' ');
function unitPath(value) {
  if (!value.startsWith('/') || /[\r\n\0]/.test(value)) throw new Error('Unit paths must be absolute');
  return value.replaceAll('%', '%%');
}

export function units({ root, config, node, opencode, database, path, externalDb }) {
  // Path directives take a single raw path; ExecStart/Environment use word quoting.
  const base = `WorkingDirectory=${unitPath(root)}\nEnvironmentFile=${unitPath(join(config, 'executor.env'))}\nEnvironment=${quote(`PATH=${path}`)}\n`;
  const wait = kind => command(node, join(root, 'scripts/runtime.mjs'), kind);
  const result = {
    'opencode-executor.service': `[Unit]\nDescription=OpenCode V2 server for Nexus Executor\nAfter=network-online.target\n\n[Service]\nType=simple\n${base}EnvironmentFile=${unitPath(join(config, 'opencode.env'))}\nExecStart=${command(opencode, 'serve', '--hostname', '127.0.0.1', '--port', '4096')}\nExecStartPost=${wait('opencode')}\nRestart=always\nRestartSec=5\nTimeoutStartSec=150\n\n[Install]\nWantedBy=default.target\n`,
    'nexus-executor.service': `[Unit]\nDescription=Nexus Executor\nWants=opencode-executor.service\nAfter=network-online.target opencode-executor.service${externalDb ? '' : ' nexus-db.service'}\n${externalDb ? '' : 'Requires=nexus-db.service\n'}\n[Service]\nType=simple\n${base}Environment=NODE_ENV=production\nExecStartPre=${wait('db')}\nExecStartPre=${command(node, join(root, 'dist/main.js'), '--migrate-only')}\nExecStart=${command(node, join(root, 'dist/main.js'))}\nRestart=always\nRestartSec=5\nTimeoutStartSec=180\n\n[Install]\nWantedBy=default.target\n`,
  };
  if (!externalDb) result['nexus-db.service'] = `[Unit]\nDescription=Nexus PostgreSQL database\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${unitPath(database.dataDir)}\nEnvironment=${quote(`PATH=${path}`)}\nExecStart=${command(join(database.pgBin, 'postgres'), '-D', database.dataDir, '-h', '127.0.0.1', '-p', String(database.port), '-k', database.socketDir)}\nRestart=on-failure\nRestartSec=5\nKillSignal=SIGINT\nTimeoutStopSec=120\n\n[Install]\nWantedBy=default.target\n`;
  return result;
}

export function install(args = process.argv.slice(2)) {
  servicesTouched = false;
  const opts = options(args);
  if (opts.help) {
    console.log('Usage: ./install.sh [--gateway URL --code CODE | --pair] [--migrate-db | --external-db] [--postgres-bin DIR] [--db-port PORT] [--backup-dir DIR] [--no-pull] [--dry-run]');
    return;
  }
  if (opts.dryRun) {
    console.log(`${opts.pull ? 'git pull --ff-only; ' : ''}npm ci; npm run build; stop executor; validated database backup; ${opts.migrateDb ? 'restore source into separate native nexus-db; ' : 'set up native nexus-db (or retain external DB); '}migrate; configure persistent passwords and user units; enable boot startup; ${opts.pair ? 'pair; ' : ''}restart OpenCode and executor (no changes made)`);
    return;
  }
  if (process.platform !== 'linux') throw new Error('This installer requires Linux with systemd user services');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js >=22 is required');
  const run = (bin, argv, extra = {}) => execFileSync(bin, argv, { cwd: repository, stdio: 'inherit', ...extra });
  const capture = (bin, argv, extra = {}) => run(bin, argv, { stdio: 'pipe', encoding: 'utf8', ...extra }).trim();
  const find = bin => capture('sh', ['-c', 'command -v "$1"', 'sh', bin]);
  const node = process.execPath;
  const opencode = find('opencode');
  for (const required of ['npm', 'git', 'tmux', 'python3', 'make', 'c++']) {
    try { find(required); }
    catch { throw new Error(`Required command not found: ${required}. See README installation prerequisites`); }
  }
  run('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  if (opts.pull) {
    if (capture('git', ['status', '--porcelain', '--untracked-files=no'])) {
      throw new Error('Checkout has uncommitted changes. Commit them before updating, or use --no-pull to install this checkout');
    }
    run('git', ['pull', '--ff-only']);
    // The updated installer, not the pre-pull version, owns subsequent deployment steps.
    run(node, [join(repository, 'scripts/install.mjs'), ...args.filter(arg => arg !== '--no-pull'), '--no-pull']);
    return;
  }
  const config = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'nexus-executor');
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
  const envFile = join(repository, '.env');
  const existingEnv = existsSync(envFile);
  const text = existingEnv ? readFileSync(envFile, 'utf8') : readFileSync(join(repository, '.env.example'), 'utf8');
  const env = parseEnv(text);
  const statePath = join(config, 'install.json');
  const previousState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const externalDb = opts.externalDb ?? (opts.migrateDb ? false : previousState.externalDb ?? false);
  const nativeFile = join(config, 'native-db.json');
  const previousNative = existsSync(nativeFile) ? JSON.parse(readFileSync(nativeFile, 'utf8')) : {};
  const pgBin = discoverPostgres(opts['postgres-bin'], previousNative.pgBin, !externalDb);
  const port = Number(opts['db-port'] || previousNative.port || 5556);
  if (previousNative.port && port !== previousNative.port) throw new Error('Changing an existing nexus-db port requires an explicit manual reconfiguration');
  const nativeEnv = readEnv(join(config, 'native-db.env'));
  const plan = databasePlan({ currentUrl: env.DATABASE_URL, previousUrl: nativeEnv.DATABASE_URL, existingEnv, migrate: opts.migrateDb, external: externalDb, port });
  if (plan.source) {
    const source = new URL(plan.source);
    if (['localhost', '127.0.0.1', '[::1]'].includes(source.hostname) && Number(source.port || 5432) === port) {
      throw new Error('Source uses the native target port. Choose a different --db-port for a safe parallel restore');
    }
  }
  const dataRoot = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'nexus-executor');
  const database = {
    pgBin, port, superuser: userInfo().username,
    dataDir: previousNative.dataDir || join(dataRoot, 'postgres'),
    socketDir: previousNative.socketDir || join(dataRoot, 'pg-socket'),
    backupDir: resolve(opts['backup-dir'] || previousNative.backupDir || join(dataRoot, 'backups')),
    envFile,
  };
  env.DATABASE_URL = plan.url;
  const previous = readEnv(join(config, 'opencode.env'));
  const { password, url } = credentials(env, previous);
  env.OPENCODE_BASE_URL = url;
  env.OPENCODE_TOKEN = password;
  // Validate every entry before stopping services or writing any configuration.
  environment(env);
  environment({ ...previous, OPENCODE_SERVER_PASSWORD: password });
  const managedEnv = dotenv({ DATABASE_URL: env.DATABASE_URL, OPENCODE_BASE_URL: url, OPENCODE_TOKEN: password });
  const generated = units({ root: repository, config, node, opencode, database, path: process.env.PATH || '/usr/bin:/bin', externalDb });
  console.log('Building Nexus Executor');
  run('npm', ['ci', '--include=dev']);
  run('npm', ['run', 'build']);
  // Linger makes enabled user services start at boot, without a login session.
  try { run('loginctl', ['enable-linger', userInfo().username]); }
  catch { throw new Error(`Enable boot startup with: sudo loginctl enable-linger ${userInfo().username}, then rerun install`); }
  if (capture('systemctl', ['--user', 'show', 'nexus-executor.service', '--property=LoadState', '--value']) !== 'not-found') {
    servicesTouched = true;
    run('systemctl', ['--user', 'stop', 'nexus-executor.service']);
  }
  mkdirSync(config, { recursive: true, mode: 0o700 });
  mkdirSync(unitDir, { recursive: true });
  const secretFile = privateFile;
  const dbScript = join(repository, 'scripts/database.mjs');
  // Do not touch application config until backup, restore and migrations succeed.
  const backupSettings = join(config, 'backup-settings.json');
  secretFile(backupSettings, JSON.stringify(database, null, 2) + '\n');
  const backup = url => {
    const archive = capture(node, [dbScript, 'backup', backupSettings], { env: { ...process.env, DATABASE_URL: url } });
    console.log('Validated database backup: ' + archive);
    return archive;
  };
  const sourceArchive = plan.source ? backup(plan.source) : null;
  const currentArchive = !sourceArchive && (externalDb || nativeEnv.DATABASE_URL) ? backup(plan.url) : null;
  if (!externalDb) {
    // These files belong to the native cluster only; the executor still points to its source.
    secretFile(nativeFile, JSON.stringify(database, null, 2) + '\n');
    secretFile(join(config, 'native-db.env'), environment({ DATABASE_URL: plan.url }));
    run(node, [dbScript, 'init', nativeFile]);
    mkdirSync(database.socketDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(unitDir, 'nexus-db.service'), generated['nexus-db.service']);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', 'nexus-db.service']);
    // Existing managed data is backed up before restarting PostgreSQL.
    servicesTouched = true;
    run('systemctl', ['--user', 'restart', 'nexus-db.service']);
    run(node, [dbScript, 'provision', nativeFile], { env: { ...process.env, DATABASE_URL: plan.url } });
    if (sourceArchive) run(node, [dbScript, 'restore', nativeFile, sourceArchive, sourceId(plan.source)], { env: { ...process.env, DATABASE_URL: plan.url } });
  }
  if (!sourceArchive && !currentArchive) backup(plan.url); // fresh native database, before first migrations
  const runtimeEnv = { ...process.env, ...env };
  run(node, [join(repository, 'scripts/runtime.mjs'), 'db'], { env: runtimeEnv });
  run(node, [join(repository, 'dist/main.js'), '--migrate-only'], { env: runtimeEnv });
  // Preserve existing comments/settings; append authoritative local-server entries.
  const retained = text.split('\n').filter(line => !/^\s*(?:export\s+)?(?:OPENCODE_TOKEN|OPENCODE_BASE_URL|DATABASE_URL)\s*=/.test(line)).join('\n');
  secretFile(envFile, `${retained}\n${managedEnv}`);
  secretFile(join(config, 'executor.env'), environment(env));
  secretFile(join(config, 'opencode.env'), environment({ ...previous, OPENCODE_SERVER_PASSWORD: password }));
  for (const [name, content] of Object.entries(generated)) writeFileSync(join(unitDir, name), content);
  secretFile(statePath, JSON.stringify({ externalDb, database: externalDb ? 'external' : 'native' }, null, 2) + '\n');
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', ...Object.keys(generated)]);
  if (opts.pair) {
    const pairArgs = [join(repository, 'bin/nexus-executor'), 'pair'];
    if (opts.gateway) pairArgs.push('--gateway', opts.gateway);
    if (opts.code) pairArgs.push('--code', opts.code);
    run(node, pairArgs, { env: runtimeEnv });
  }
  // Local symlink avoids npm-global write permissions; ensure ~/.local/bin is on PATH.
  run('mkdir', ['-p', join(homedir(), '.local/bin')]);
  run('ln', ['-sfn', join(repository, 'bin/nexus-executor'), join(homedir(), '.local/bin/nexus-executor')]);
  servicesTouched = true;
  run('systemctl', ['--user', 'restart', 'opencode-executor.service']);
  run('systemctl', ['--user', 'restart', 'nexus-executor.service']);
  run('systemctl', ['--user', 'is-active', 'opencode-executor.service', 'nexus-executor.service']);
  console.log('Installed/updated. Configuration: ' + config + '\nEnsure ~/.local/bin is on PATH. Pair once with nexus-executor pair, then restart nexus-executor.service.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { install(); } catch (error) {
    console.error(`Installation failed: ${error.message}. ${servicesTouched
      ? 'Services may be stopped; fix the error and rerun install.'
      : 'Existing database configuration and running services have not been changed.'}`);
    process.exitCode = 1;
  }
}
