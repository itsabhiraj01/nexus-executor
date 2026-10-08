import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * `nexus-executor update` — best-effort, NON-destructive self-update:
 * `git pull --ff-only` + `npm install` + `npm run build`. Never touches data;
 * returns a restart hint instead of auto-restarting so the operator (and the
 * systemd unit) controls when the new code goes live.
 */

export function update(): string {
  if (!existsSync('.git')) {
    return 'update: not a git checkout (nothing to pull) — rebuild via the installed package manager.';
  }
  execFileSync('git', ['pull', '--ff-only'], { stdio: 'inherit' });
  execFileSync('npm', ['install'], { stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  return 'update: rebuilt — restart the service (systemctl --user restart nexus-executor).';
}