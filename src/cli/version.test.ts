import { describe, expect, it } from 'vitest';
import { versionText } from './version.js';

describe('versionText', () => {
  it('reports the executor and protocol versions', () => {
    expect(versionText()).toMatch(/^nexus-executor v\d+\.\d+\.\d+/);
    expect(versionText()).toContain('protocol');
  });
});