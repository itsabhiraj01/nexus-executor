import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { waitFor } from './runtime.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
export class DatabaseSafetyError extends Error {}
export const sourceId = url => createHash('sha256').update(url).digest('hex');
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
export function privateFile(path, content) {
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, content, { mode: 0o600 });
}

export function discoverPostgres(explicit, previous, server = true) {
  const tools = server ? ['postgres', 'initdb', 'pg_dump', 'pg_restore'] : ['pg_dump', 'pg_restore'];
  const usable = dir => tools.every(tool => existsSync(join(dir, tool)));
  const canonical = dir => {
    // Pin the real Nix store/package directory, not a mutable profile symlink.
    const actual = dirname(realpathSync(join(dir, tools[0])));
    return usable(actual) ? actual : resolve(dir);
  };
  if (explicit || previous) {
    const dir = resolve(explicit || previous);
    if (!usable(dir)) throw new DatabaseSafetyError('PostgreSQL binaries missing; install postgresql and postgresql-client or set --postgres-bin DIR');
    return canonical(dir);
  }
  try {
    const dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (usable(dir)) return canonical(dir);
  } catch { /* Debian packages need not put pg_config on PATH. */ }
  const directories = (process.env.PATH || '').split(':');
  if (existsSync('/usr/lib/postgresql')) {
    directories.unshift(...readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a)).map(version => `/usr/lib/postgresql/${version}/bin`));
  }
  const found = directories.find(usable);
  if (!found) throw new DatabaseSafetyError('Install native PostgreSQL server/client tools (sudo apt install postgresql postgresql-client), or set --postgres-bin DIR');
  return canonical(found);
}

export function databasePlan({ currentUrl, previousUrl, existingEnv, migrate, external, port = 5556 }) {
  if (external) {
    if (!currentUrl) throw new DatabaseSafetyError('--external-db requires DATABASE_URL in .env');
    if (migrate) throw new DatabaseSafetyError('--migrate-db cannot be combined with --external-db');
    return { url: currentUrl, source: null };
  }
  const url = previousUrl || `postgres://nexus_executor:${randomBytes(32).toString('hex')}@127.0.0.1:${port}/nexus_executor`;
  const target = new URL(url);
  if (target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1' || Number(target.port) !== port
      || target.username !== 'nexus_executor' || target.pathname !== '/nexus_executor' || !target.password || target.search) {
    throw new DatabaseSafetyError('Stored native database connection does not match the managed local cluster');
  }
  const source = existingEnv && currentUrl && currentUrl !== url ? currentUrl : null;
  if (source && !migrate) throw new DatabaseSafetyError('Existing DATABASE_URL will not be replaced. Use --migrate-db to back up and restore it into nexus-db, or --external-db to keep using it');
  return { url, source };
}

export function pgEnvironment(url) {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new DatabaseSafetyError('DATABASE_URL must be a PostgreSQL URL');
  if (parsed.search) throw new DatabaseSafetyError('Backup URLs with connection query options are not supported; use a plain PostgreSQL URL');
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))),
    PGHOST: parsed.hostname, PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)), PGCONNECT_TIMEOUT: '5',
    PGSSLMODE: 'prefer',
  };
}

function tool(settings, name, args, env) {
  // Credentials are passed only through the environment, never argv or logs.
  return execFileSync(join(settings.pgBin, name), args, {
    env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
}
async function client(options, task) {
  const { default: pg } = await import('pg');
  const connection = new pg.Client({ ...options, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  try { await connection.connect(); return await task(connection); }
  finally { await connection.end().catch(() => {}); }
}

export function initialize(settings) {
  const marker = join(settings.dataDir, 'nexus-managed.json');
  if (existsSync(join(settings.dataDir, 'PG_VERSION'))) {
    if (!existsSync(marker)) throw new DatabaseSafetyError('Refusing to adopt an unrecognized PostgreSQL data directory');
    const owner = JSON.parse(readFileSync(marker, 'utf8'));
    if (owner.superuser !== settings.superuser || owner.port !== settings.port) throw new DatabaseSafetyError('Existing nexus-db cluster settings differ; refusing to reinitialize');
    const version = readFileSync(join(settings.dataDir, 'PG_VERSION'), 'utf8').trim();
    const binaryVersion = tool(settings, 'postgres', ['--version']);
    if (!new RegExp(`\\b${version.replaceAll('.', '\\.')}[.\\s]`).test(binaryVersion)) {
      throw new DatabaseSafetyError(`PostgreSQL major upgrade requires an explicit dump/restore; keep PostgreSQL ${version} binaries for this cluster`);
    }
    return;
  }
  if (existsSync(settings.dataDir) && readdirSync(settings.dataDir).length) {
    throw new DatabaseSafetyError('PostgreSQL data directory is nonempty but uninitialized; refusing to overwrite it');
  }
  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  tool(settings, 'initdb', ['-D', settings.dataDir, '--username', settings.superuser, '--auth-local=peer', '--auth-host=scram-sha-256']);
  privateFile(marker, JSON.stringify({ superuser: settings.superuser, port: settings.port }) + '\n');
}

export async function provision(settings, url, connect = client) {
  const target = new URL(url);
  const role = decodeURIComponent(target.username);
  const database = decodeURIComponent(target.pathname.slice(1));
  const admin = { host: settings.socketDir, port: settings.port, user: settings.superuser, database: 'postgres' };
  await waitFor(() => connect(admin, c => c.query('SELECT 1')), 'Native PostgreSQL', 30);
  await connect(admin, async c => {
    const roles = await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!roles.rowCount) await c.query(`CREATE ROLE ${identifier(role)} LOGIN PASSWORD ${literal(decodeURIComponent(target.password))}`);
    const databases = await c.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [database]);
    if (!databases.rowCount) await c.query(`CREATE DATABASE ${identifier(database)} OWNER ${identifier(role)}`);
    else if (databases.rows[0].owner !== role) throw new DatabaseSafetyError('Existing database has a different owner; refusing to change it');
  });
  // Reused credentials must work; never silently change an existing role's password.
  await connect({ connectionString: url }, c => c.query('SELECT 1'));
}

async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function backup(settings, url, connect = client) {
  if (!url) throw new DatabaseSafetyError('DATABASE_URL is required for backup');
  const version = await connect({ connectionString: url }, async c => (await c.query('SHOW server_version')).rows[0].server_version);
  mkdirSync(settings.backupDir, { recursive: true, mode: 0o700 });
  const directory = join(settings.backupDir, `${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(4).toString('hex')}`);
  mkdirSync(directory, { mode: 0o700 });
  const archive = join(directory, 'database.dump');
  privateFile(archive, '');
  // pg_dump's consistent snapshot preserves tables, sequences and migration history.
  tool(settings, 'pg_dump', ['--format=custom', '--file', archive, '--no-owner', '--no-acl'], pgEnvironment(url));
  if (!statSync(archive).size) throw new DatabaseSafetyError('Database backup is empty');
  tool(settings, 'pg_restore', ['--list', archive]);
  const digest = await checksum(archive);
  const parsed = new URL(url);
  privateFile(join(directory, 'manifest.json'), JSON.stringify({
    sha256: digest, serverVersion: version, sourceId: sourceId(url),
    host: parsed.hostname, port: parsed.port || '5432', database: parsed.pathname.slice(1),
  }, null, 2) + '\n');
  if (settings.envFile && existsSync(settings.envFile)) privateFile(join(directory, 'source.env'), readFileSync(settings.envFile));
  return archive;
}

export async function restore(settings, targetUrl, archive, expectedSourceId, connect = client) {
  const completionFile = join(settings.dataDir, 'nexus-restore.json');
  if (existsSync(completionFile)) {
    const completion = JSON.parse(readFileSync(completionFile, 'utf8'));
    if (completion.sourceId !== expectedSourceId) throw new DatabaseSafetyError('Target already contains a restore from a different source');
    // A retry resumes an already completed restore, never merges newer source writes.
    return;
  }
  const manifest = JSON.parse(readFileSync(join(resolve(archive, '..'), 'manifest.json'), 'utf8'));
  if (manifest.sourceId !== expectedSourceId || manifest.sha256 !== await checksum(archive)) throw new DatabaseSafetyError('Backup checksum or source does not match');
  await connect({ connectionString: targetUrl }, async c => {
    const objects = await c.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      UNION ALL SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%' LIMIT 1`);
    if (objects.rowCount) throw new DatabaseSafetyError('Restore target is not empty; refusing to overwrite data');
  });
  tool(settings, 'pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', '--dbname', new URL(targetUrl).pathname.slice(1), archive], pgEnvironment(targetUrl));
  privateFile(completionFile, JSON.stringify({ sourceId: expectedSourceId, archive, sha256: manifest.sha256 }) + '\n');
}

export async function main(args = process.argv.slice(2)) {
  const [action, settingsFile, archive, expectedSourceId] = args;
  let settings;
  if (settingsFile) settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  else {
    const config = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'nexus-executor');
    const saved = join(config, 'native-db.json');
    settings = existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')) : {
      pgBin: discoverPostgres(process.env.NEXUS_POSTGRES_BIN),
      backupDir: join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'nexus-executor/backups'),
      envFile: join(root, '.env'),
    };
  }
  const env = settings.envFile && existsSync(settings.envFile) ? parseEnv(readFileSync(settings.envFile, 'utf8')) : {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (action === 'init') initialize(settings);
  else if (action === 'provision') await provision(settings, url);
  else if (action === 'backup') console.log(await backup(settings, url));
  else if (action === 'restore') await restore(settings, url, archive, expectedSourceId);
  else throw new DatabaseSafetyError('Usage: database.mjs init|provision|backup|restore [settings.json] [archive sourceId]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Driver/tool errors can contain credentials; keep raw details out of console logs.
    console.error(error instanceof DatabaseSafetyError ? error.message : 'Database operation failed. No source database was deleted. Check connection, tool version, backup permissions, and target state.');
    process.exitCode = 1;
  });
}
