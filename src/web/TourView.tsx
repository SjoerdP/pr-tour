import { useMemo, useState } from 'react';
import { BuildStatus } from './BuildStatus.js';
import { homesInOrder } from './homes.js';
import { Outline } from './Outline.js';
import { StepPane } from './StepPane.js';
import { useKeys } from './useKeys.js';
import { useSeenMarks } from './useSeenMarks.js';
import { useTourBuild } from './useTourBuild.js';

const NO_MARKS: Record<string, string> = {};

/** The review screen of one PR: build its tour, then read it home by home. */
export function TourView({ repo, pr }: { repo: string; pr: number }) {
  const { load, build, startBuild } = useTourBuild(repo, pr);
  const data = load.status === 'ready' ? load.data : null;
  const tour = data?.tour ?? null;
  const {
    isSeen,
    markLeft,
    error: seenError,
  } = useSeenMarks(repo, pr, tour, data?.seen ?? NO_MARKS);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [jump, setJump] = useState<{ file: string; line: number } | null>(null);

  // The outline's order is the reading order: j/k walk the same list.
  const homes = useMemo(() => (tour ? homesInOrder(tour) : []), [tour]);
  const ids = useMemo(() => homes.map((h) => h.id), [homes]);
  // After a rebuild the old id may be gone; fall back to the first home.
  const current = currentId !== null && ids.includes(currentId) ? currentId : (ids[0] ?? null);

  /** Moving past a home marks it seen; opening one does not. */
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
    // Back from a followed call to the step's own code.
    ...(jump ? { Escape: () => setJump(null) } : {}),
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
  const currentHome = homes.find((h) => h.id === current);

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
            onOpenHome={goTo}
          />
        </div>
      )}
    </main>
  );
}
