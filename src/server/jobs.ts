import type { Job } from '../shared/api.js';

export type { Job } from '../shared/api.js';

/** How many log lines a job keeps. */
const LOG_LINES = 50;

/**
 * In-memory background jobs, one per key (a PR). A job's error is its thrown
 * error's `message`, so callers throw errors with short, readable messages.
 */
export class Jobs {
  private readonly jobs = new Map<string, Job>();

  /**
   * Run `fn` as the job for `key`, unless that job is still running. `fn` adds lines to the
   * log, and sets or clears (`undefined`) one progress line that replaces itself.
   */
  start(
    key: string,
    fn: (
      log: (line: string) => void,
      progress: (line: string | undefined) => void,
    ) => Promise<unknown>,
  ): void {
    if (this.jobs.get(key)?.state === 'running') return;
    const job: Job = { state: 'running', log: [], startedAt: new Date().toISOString() };
    this.jobs.set(key, job);
    const log = (line: string) => {
      job.log.push(line);
      if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
    };
    const progress = (line: string | undefined) => {
      if (line === undefined) delete job.progress;
      else job.progress = line;
    };
    // Calls `fn` now; a synchronous throw becomes a rejection like any other failure.
    const run = new Promise<unknown>((resolve) => resolve(fn(log, progress)));
    void run.then(
      () => {
        job.state = 'done';
        job.endedAt = new Date().toISOString();
      },
      (err: unknown) => {
        // Kept as the job's state for the UI to show; the caller logs details.
        job.state = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.endedAt = new Date().toISOString();
      },
    );
  }

  get(key: string): Job | null {
    const job = this.jobs.get(key);
    return job ? { ...job, log: [...job.log] } : null;
  }
}
