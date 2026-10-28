import { useEffect, useState } from 'react';
import type { Job, PrResponse } from '../shared/api.js';
import { buildTour, getPr } from './api.js';
import { errorText } from './errors.js';

/** How often a running build is checked. */
const POLL_MS = 2000;

/** Failed status checks in a row before the page stops checking. */
const MAX_POLL_FAILURES = 3;

export type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PrResponse };

/**
 * A build the user started here or that was already running.
 * `starting` waits for the server to accept it; only `running` polls.
 * `pollError` is set while a status check failed and the next one is pending.
 */
export type Build =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'running'; log: string[]; pollError?: string }
  | { state: 'failed'; error: string; log: string[] };

function buildFromJob(job: Job | null): Build {
  if (!job || job.state === 'done') return { state: 'idle' };
  if (job.state === 'running') return { state: 'running', log: job.log };
  return { state: 'failed', error: job.error ?? 'The build failed.', log: job.log };
}

function logOf(build: Build): string[] {
  return build.state === 'running' || build.state === 'failed' ? build.log : [];
}

/**
 * The PR and its tour from the server, and the tour build: starting one, then checking
 * on it every 2 s until it is done or failed. Checking stops when the page goes away.
 */
export function useTourBuild(
  repo: string,
  pr: number,
): { load: Load; build: Build; startBuild: () => void } {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [build, setBuild] = useState<Build>({ state: 'idle' });

  useEffect(() => {
    let active = true;
    getPr(repo, pr).then(
      (data) => {
        if (!active) return;
        setLoad({ status: 'ready', data });
        setBuild(buildFromJob(data.job));
      },
      (err: unknown) => {
        if (active) setLoad({ status: 'error', message: errorText(err) });
      },
    );
    return () => {
      active = false;
    };
  }, [repo, pr]);

  const polling = build.state === 'running';
  useEffect(() => {
    if (!polling) return;
    let active = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      getPr(repo, pr).then(
        (data) => {
          if (!active) return;
          failures = 0;
          setLoad({ status: 'ready', data });
          const next = buildFromJob(data.job);
          setBuild(next);
          if (next.state === 'running') timer = setTimeout(poll, POLL_MS);
        },
        (err: unknown) => {
          if (!active) return;
          // A failed check says nothing about the build itself: keep its log and try again.
          failures += 1;
          const message = `Couldn't check the build status: ${errorText(err)}`;
          if (failures < MAX_POLL_FAILURES) {
            setBuild((prev) => (prev.state === 'running' ? { ...prev, pollError: message } : prev));
            timer = setTimeout(poll, POLL_MS);
          } else {
            setBuild((prev) => ({ state: 'failed', error: message, log: logOf(prev) }));
          }
        },
      );
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [polling, repo, pr]);

  function startBuild() {
    setBuild({ state: 'starting' });
    buildTour(repo, pr).then(
      ({ job }) => setBuild(job ? buildFromJob(job) : { state: 'running', log: [] }),
      (err: unknown) => setBuild({ state: 'failed', error: errorText(err), log: [] }),
    );
  }

  return { load, build, startBuild };
}
