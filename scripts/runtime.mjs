import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Used by systemd too: database/container startup and OpenCode startup are asynchronous.
export async function waitFor(check, label, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await check(); return; } catch { /* retry without logging credentials */ }
    if (attempt + 1 < attempts) await delay(1000);
  }
  throw new Error(`${label} did not become ready within ${attempts} attempts`);
}

export async function ready(kind) {
  if (kind === 'db') {
    const { default: pg } = await import('pg');
    await waitFor(async () => {
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1000 });
      try { await client.connect(); await client.query('SELECT 1'); }
      finally { await client.end().catch(() => {}); }
    }, 'PostgreSQL');
  } else if (kind === 'opencode') {
    await waitFor(async () => {
      const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_TOKEN}`).toString('base64')}`;
      const response = await fetch(`${process.env.OPENCODE_BASE_URL}/api/info`, {
        headers: { authorization }, signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) throw new Error('OpenCode is not ready');
    }, 'Authenticated OpenCode');
  } else {
    throw new Error('Usage: runtime.mjs db|opencode');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ready(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
