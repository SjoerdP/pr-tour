import { describe, expect, it } from 'vitest';
import { Jobs } from '../../src/server/jobs.js';

/** A promise and the functions that settle it. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Jobs', () => {
  it('get returns null for a key that never started', () => {
    expect(new Jobs().get('acme/api#1')).toBeNull();
  });

  it('a job is running until its function resolves, then done', async () => {
    const jobs = new Jobs();
    const run = deferred();
    jobs.start('k', () => run.promise);
    expect(jobs.get('k')?.state).toBe('running');

    run.resolve();
    await flush();

    expect(jobs.get('k')).toEqual({ state: 'done', log: [] });
  });

  it('a job that throws is failed with the error message', async () => {
    const jobs = new Jobs();
    jobs.start('k', () => Promise.reject(new Error('Claude failed to run.')));
    await flush();

    expect(jobs.get('k')).toMatchObject({ state: 'failed', error: 'Claude failed to run.' });
  });

  it('starting a running key is a no-op', async () => {
    const jobs = new Jobs();
    const first = deferred();
    let calls = 0;
    const fn = () => {
      calls++;
      return first.promise;
    };
    jobs.start('k', fn);
    jobs.start('k', fn);
    expect(calls).toBe(1);

    first.resolve();
    await flush();
    jobs.start('k', fn);
    expect(calls).toBe(2);
    expect(jobs.get('k')?.state).toBe('running');
  });

  it('a restarted job starts with an empty log', async () => {
    const jobs = new Jobs();
    jobs.start('k', (log) => {
      log('first run');
      return Promise.resolve();
    });
    await flush();
    jobs.start('k', () => new Promise(() => {}));

    expect(jobs.get('k')?.log).toEqual([]);
  });

  it('the log keeps the last 50 lines', async () => {
    const jobs = new Jobs();
    jobs.start('k', (log) => {
      for (let i = 1; i <= 60; i++) log(`line ${i}`);
      return Promise.resolve();
    });
    await flush();

    const log = jobs.get('k')?.log ?? [];
    expect(log).toHaveLength(50);
    expect(log[0]).toBe('line 11');
    expect(log[49]).toBe('line 60');
  });

  it('get returns a copy that later log lines do not change', () => {
    const jobs = new Jobs();
    let log: (line: string) => void = () => {};
    jobs.start('k', (l) => {
      log = l;
      return new Promise(() => {});
    });
    const before = jobs.get('k');
    log('later');

    expect(before?.log).toEqual([]);
    expect(jobs.get('k')?.log).toEqual(['later']);
  });
});
