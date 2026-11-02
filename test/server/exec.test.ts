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

  it('passes extra env vars to the child', async () => {
    const result = await realRunner(process.execPath, ['-p', 'process.env.PR_TOUR_TEST_VAR'], {
      env: { PR_TOUR_TEST_VAR: 'hello' },
    });
    expect(result.stdout.trim()).toBe('hello');
  });

  it('reports a missing command as a non-zero code and "not found" first', async () => {
    const result = await realRunner('pr-tour-no-such-command', []);
    expect(result.code).not.toBe(0);
    expect(result.stderr.split('\n')[0]).toBe('pr-tour-no-such-command not found');
  });

  it('reports a command killed by the timeout as "timed out" first', async () => {
    const result = await realRunner(
      process.execPath,
      ['-e', 'console.error("still working"); setTimeout(() => {}, 10000)'],
      { timeoutMs: 300 },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr.split('\n')[0]).toBe(`${process.execPath} timed out after 0.3 s`);
    expect(new CommandError('node', [], result).shortMessage).toContain('timed out after 0.3 s');
  });

  it('stops a command that prints nothing for idleTimeoutMs', async () => {
    const result = await realRunner(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      idleTimeoutMs: 300,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr.split('\n')[0]).toBe(`${process.execPath} printed nothing for 0.3 s`);
  });

  it('keeps a command running while it prints, past idleTimeoutMs', async () => {
    // Wide margins: a busy machine can take a while to start node.
    const script =
      'let n = 0; const t = setInterval(() => { console.log(n++); if (n === 6) clearInterval(t); }, 500)';
    const result = await realRunner(process.execPath, ['-e', script], { idleTimeoutMs: 2000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('0\n1\n2\n3\n4\n5\n');
  });

  it('names the total limit when it hits first, even with an idle limit set', async () => {
    const script = 'setInterval(() => console.log("busy"), 50)';
    const result = await realRunner(process.execPath, ['-e', script], {
      timeoutMs: 1500,
      idleTimeoutMs: 3000,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr.split('\n')[0]).toBe(`${process.execPath} timed out after 1.5 s`);
  });

  it('force-stops a command that ignores the stop signal', async () => {
    const script = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
    const result = await realRunner(process.execPath, ['-e', script], { idleTimeoutMs: 300 });
    expect(result.code).not.toBe(0);
    expect(result.stderr.split('\n')[0]).toBe(`${process.execPath} printed nothing for 0.3 s`);
  }, 15_000);

  it('passes a last stdout line without a newline to onLine', async () => {
    const lines: string[] = [];
    await realRunner(process.execPath, ['-e', 'process.stdout.write("a\\nb")'], {
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['a', 'b']);
  });

  it('calls onLine with each stdout line as it arrives', async () => {
    const lines: string[] = [];
    const script =
      'process.stdout.write("a\\nb"); setTimeout(() => process.stdout.write("c\\nd\\n"), 50)';
    const result = await realRunner(process.execPath, ['-e', script], {
      onLine: (line) => lines.push(line),
    });
    expect(result.stdout).toBe('a\nbc\nd\n');
    expect(lines).toEqual(['a', 'bc', 'd']);
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
