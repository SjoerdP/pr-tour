import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CommandError, realRunner } from '../../src/server/exec.js';

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

describe('CommandError', () => {
  const error = (stderr: string, code = 1) =>
    new CommandError('gh', ['api', 'graphql', '-f', 'query=query { viewer { login } }'], {
      stdout: '',
      stderr,
      code,
    });

  it('message has the command and stderr, for the log', () => {
    const e = error('gh: not logged in');
    expect(e.message).toContain('query { viewer');
    expect(e.message).toContain('gh: not logged in');
  });

  it('shortMessage is the program and the first stderr line', () => {
    expect(error('\n  GraphQL: rate limited  \nsee docs\n').shortMessage).toBe(
      'gh failed: GraphQL: rate limited',
    );
  });

  it('shortMessage falls back to the exit code without stderr', () => {
    expect(error('', 4).shortMessage).toBe('gh failed with exit code 4');
  });

  it('shortMessage cuts a very long line', () => {
    expect(error('x'.repeat(1000)).shortMessage.length).toBeLessThanOrEqual(220);
  });
});
