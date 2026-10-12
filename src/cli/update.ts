import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Use the same full-stack deployment path as install / make update.
 * Resolve from the installed module, not the caller's working directory.
 */

export function update(): string {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (!existsSync(new URL('../../.git', import.meta.url))) {
    return 'update: not a git checkout (nothing to pull) — rebuild via the installed package manager.';
  }
  execFileSync('bash', [fileURLToPath(new URL('../../install.sh', import.meta.url))], { cwd: root, stdio: 'inherit' });
  return 'update: pulled, built, backed up, migrated, and restarted Nexus services.';
}
