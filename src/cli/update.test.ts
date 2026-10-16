import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { update } from './update.js';

describe('update', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the shared installer from the installed checkout, not the caller cwd', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(update()).toContain('migrated');
    expect(execFileSync).toHaveBeenCalledWith('bash', [
      fileURLToPath(new URL('../../install.sh', import.meta.url)),
    ], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit',
    });
  });

  it('does not deploy a non-checkout package', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(update()).toContain('not a git checkout');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('propagates deployment failures', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('migration failed'); });
    expect(() => update()).toThrow('migration failed');
  });
});
