import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXECUTOR_VERSION, executorCapabilities, loadConfig } from './config.js';

/**
 * The executor's reported version is SINGLE-SOURCED from package.json — the
 * hub reads the same file to compute "latest", so a hand-maintained second
 * copy drifting from it (the 0.3.0/0.4.0 split) must be impossible.
 */

const REQUIRED_ENV = { DATABASE_URL: 'postgres://nexus:nexus@localhost:5544/nexus_executor_test' };

describe('EXECUTOR_VERSION', () => {
  it('is package.json verbatim — one source of truth for hub "latest" reads', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    expect(pkg.version).toBeTruthy();
    expect(EXECUTOR_VERSION).toBe(pkg.version);
  });
});

describe('loadConfig — upgrade knobs', () => {
  it('defaults: no command/repo, ref main, the stock unit name', () => {
    const config = loadConfig({ ...REQUIRED_ENV });
    expect(config.upgradeCommand).toBeNull();
    expect(config.upgradeRepoDir).toBeNull();
    expect(config.upgradeRef).toBe('main');
    expect(config.upgradeServiceName).toBe('nexus-executor');
    expect(config.upgradeInstallDir).toBeNull();
  });

  it('reads EXECUTOR_UPGRADE_COMMAND / EXECUTOR_REPO_DIR / EXECUTOR_UPGRADE_REF / EXECUTOR_SERVICE_NAME / EXECUTOR_INSTALL_DIR', () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      EXECUTOR_UPGRADE_COMMAND: 'echo upgrade',
      EXECUTOR_REPO_DIR: ' /srv/nexus ',
      EXECUTOR_UPGRADE_REF: 'stable',
      EXECUTOR_SERVICE_NAME: 'nexus-executor-office',
      EXECUTOR_INSTALL_DIR: '/srv/nexus/executor',
    });
    expect(config.upgradeCommand).toBe('echo upgrade');
    expect(config.upgradeRepoDir).toBe('/srv/nexus');
    expect(config.upgradeRef).toBe('stable');
    expect(config.upgradeServiceName).toBe('nexus-executor-office');
    expect(config.upgradeInstallDir).toBe('/srv/nexus/executor');
  });
});

describe('executorCapabilities — selfUpgrade gate', () => {
  const base = loadConfig({ ...REQUIRED_ENV });

  it('advertises selfUpgrade only when an upgrade command resolves', () => {
    expect(executorCapabilities({ ...base, upgradeCommand: 'echo upgrade' }).selfUpgrade).toBe(true);
    expect(executorCapabilities(base).selfUpgrade).toBeUndefined();
    // A repo dir without the shipped script resolves nothing.
    expect(executorCapabilities({ ...base, upgradeRepoDir: '/definitely/not/here' }).selfUpgrade).toBeUndefined();
    // This checkout resolves the shipped script (scripts/self-upgrade.sh —
    // an executor-only checkout IS the executor directory).
    expect(executorCapabilities({ ...base, upgradeRepoDir: new URL('../', import.meta.url).pathname }).selfUpgrade).toBe(true);
  });
});
