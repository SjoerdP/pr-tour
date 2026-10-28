import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { realRunner } from '../../src/server/exec.js';

describe('realRunner', () => {
  it('returns the exit code and output instead of throwing', async () => {
    const result = await realRunner('git', ['rev-parse', '--verify', 'nope'], {
      cwd: import.meta.dirname,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });

  it('passes input on stdin', async () => {
    const result = await realRunner('git', ['hash-object', '--stdin'], { input: 'hi\n' });
    expect(result).toEqual({
      stdout: execFileSync('git', ['hash-object', '--stdin'], { input: 'hi\n', encoding: 'utf8' }),
      stderr: '',
      code: 0,
    });
  });

  it('reports a missing command as a non-zero code', async () => {
    const result = await realRunner('pr-tour-no-such-command', []);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/ENOENT/);
  });
});
