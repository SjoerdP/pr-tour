import { useEffect, useMemo, useState } from 'react';
import type { Job, PrResponse } from '../shared/api.js';
import { homeIds } from '../shared/tour.js';
import { buildTour, getPr, markSeen } from './api.js';
import { Outline } from './Outline.js';
import { homesById, StepPane } from './StepPane.js';
import { useKeys } from './useKeys.js';

/** How often a running build is checked. */
const POLL_MS = 2000;

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PrResponse };

/**
 * A build the user started here or that was already running.
 * `starting` waits for the server to accept it; only `running` polls.
 */
type Build =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'running'; log: string[] }
  | { state: 'failed'; error: string; log: string[] };

function buildFromJob(job: Job | null): Build {
  if (!job || job.state === 'done') return { state: 'idle' };
  if (job.state === 'running') return { state: 'running', log: job.log };
  return { state: 'failed', error: job.error ?? 'The build failed.', log: job.log };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The review screen of one PR: build its tour, then read it home by home. */
export function TourView({ repo, pr }: { repo: string; pr: number }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [build, setBuild] = useState<Build>({ state: 'idle' });
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [jump, setJump] = useState<{ file: string; line: number } | null>(null);
  const [seenError, setSeenError] = useState<string | null>(null);

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
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      getPr(repo, pr).then(
        (data) => {
          if (!active) return;
          setLoad({ status: 'ready', data });
          const next = buildFromJob(data.job);
          setBuild(next);
          if (next.state === 'running') timer = setTimeout(poll, POLL_MS);
        },
        (err: unknown) => {
          if (active) setBuild({ state: 'failed', error: errorText(err), log: [] });
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

  const data = load.status === 'ready' ? load.data : null;
  const tour = data?.tour ?? null;
  const ids = useMemo(() => (tour ? homeIds(tour) : []), [tour]);
  const homes = useMemo(() => (tour ? homesById(tour) : null), [tour]);
  // After a rebuild the old id may be gone; fall back to the first home.
  const current = currentId !== null && ids.includes(currentId) ? currentId : (ids[0] ?? null);

  function isSeen(homeId: string): boolean {
    const hash = tour?.hashes[homeId];
    return hash !== undefined && data?.seen[homeId] === hash;
  }

  /** Marks a home seen: shown at once, saved in the background. Failing to save never blocks reading. */
  function markLeft(homeId: string) {
    const hash = tour?.hashes[homeId];
    if (hash === undefined || isSeen(homeId)) return;
    const setSeen = (value: string | undefined) =>
      setLoad((prev) => {
        if (prev.status !== 'ready') return prev;
        const seen = { ...prev.data.seen };
        if (value === undefined) delete seen[homeId];
        else seen[homeId] = value;
        return { status: 'ready', data: { ...prev.data, seen } };
      });
    const before = data?.seen[homeId];
    setSeen(hash);
    markSeen(repo, pr, homeId, hash).then(
      () => setSeenError(null),
      (err: unknown) => {
        setSeen(before);
        setSeenError(`Could not save that you saw this step: ${errorText(err)}`);
      },
    );
  }

  function goTo(homeId: string | undefined) {
    if (homeId === undefined || current === null || homeId === current) return;
    markLeft(current);
    setCurrentId(homeId);
    setJump(null);
  }

  const index = current === null ? -1 : ids.indexOf(current);
  useKeys({
    j: () => goTo(ids[index + 1]),
    k: () => goTo(index > 0 ? ids[index - 1] : undefined),
  });

  if (load.status === 'loading') {
    return (
      <main className="page">
        <p className="muted">Loading the pull request…</p>
      </main>
    );
  }
  if (load.status === 'error') {
    return (
      <main className="page">
        <p>
          <a href="/">← Inbox</a>
        </p>
        <p className="error" role="alert">
          Could not load {repo}#{pr}: {load.message}
        </p>
      </main>
    );
  }

  const { pr: summary, outdated } = load.data;
  const currentHome = current !== null ? homes?.get(current) : undefined;

  return (
    <main className="page page-wide">
      <header className="tour-header">
        <p>
          <a href="/">← Inbox</a>
        </p>
        <h1 className="page-title">
          <span className="pr-number">
            {summary.repo}#{summary.number}
          </span>{' '}
          <a href={summary.url}>{summary.title}</a>
        </h1>
        {tour && <p className="tour-summary">{tour.summary}</p>}
      </header>

      {tour && outdated && (
        <div className="banner">
          <span>New commits since this tour was built</span>{' '}
          <button
            type="button"
            onClick={startBuild}
            disabled={build.state === 'starting' || build.state === 'running'}
          >
            Rebuild tour
          </button>
        </div>
      )}
      {tour ? (
        build.state !== 'idle' && <BuildStatus build={build} onRetry={startBuild} />
      ) : (
        <section className="build-panel">
          <p>There is no tour for this pull request yet.</p>
          {build.state === 'idle' ? (
            <button type="button" onClick={startBuild}>
              Build tour
            </button>
          ) : (
            <BuildStatus build={build} onRetry={startBuild} />
          )}
        </section>
      )}

      {seenError && (
        <p className="error seen-error" role="status">
          {seenError}
        </p>
      )}

      {tour && current !== null && currentHome && (
        <div className="tour-layout">
          <Outline tour={tour} currentId={current} isSeen={isSeen} onSelect={goTo} />
          <StepPane
            repo={repo}
            pr={pr}
            tour={tour}
            home={currentHome}
            jump={jump}
            onJump={(file, line) => setJump({ file, line })}
            onBack={() => setJump(null)}
          />
        </div>
      )}
    </main>
  );
}

function BuildStatus({ build, onRetry }: { build: Build; onRetry: () => void }) {
  if (build.state === 'idle') return null;
  if (build.state === 'failed') {
    return (
      <div className="build-status">
        <p className="error" role="alert">
          The tour build failed: {build.error}
        </p>
        <button type="button" onClick={onRetry}>
          Try again
        </button>
        <JobLog log={build.log} />
      </div>
    );
  }
  return (
    <div className="build-status" aria-busy="true">
      <p className="muted">Building the tour… this can take a few minutes.</p>
      {build.state === 'running' && <JobLog log={build.log} />}
    </div>
  );
}

function JobLog({ log }: { log: string[] }) {
  if (log.length === 0) return null;
  return (
    <pre className="job-log" aria-label="Build log">
      {log.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </pre>
  );
}
