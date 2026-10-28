import { useEffect, useMemo, useRef, useState } from 'react';
import { BuildStatus } from './BuildStatus.js';
import { ComposerMemory, ComposerMemoryContext } from './composer-memory.js';
import { homesInOrder, nextFlowStart, previousFlowStart } from './homes.js';
import { Outline } from './Outline.js';
import { StepPane } from './StepPane.js';
import { TopBar } from './TopBar.js';
import { useAboutPanel } from './useAboutPanel.js';
import { useKeys } from './useKeys.js';
import { useReview } from './useReview.js';
import { useSeenMarks } from './useSeenMarks.js';
import { useTourBuild } from './useTourBuild.js';

const NO_MARKS: Record<string, string> = {};

/** The review screen of one PR: build its tour, then read it home by home. */
export function TourView({ repo, pr }: { repo: string; pr: number }) {
  const { load, build, startBuild, confirmReplace, cancelReplace } = useTourBuild(repo, pr);
  const data = load.status === 'ready' ? load.data : null;
  const tour = data?.tour ?? null;
  const {
    isSeen,
    markLeft,
    error: seenError,
  } = useSeenMarks(repo, pr, tour, data?.seen ?? NO_MARKS);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [jump, setJump] = useState<{ file: string; line: number } | null>(null);
  const about = useAboutPanel(repo, pr, tour !== null);
  // One review for the PR, shared by everything that shows or adds comments.
  const review = useReview(repo, pr);
  // What the reviewer is writing, kept across moves through this PR's tour.
  const memory = useMemo(() => new ComposerMemory(`${repo}#${pr}`), [repo, pr]);
  // A rebuild swaps in a tour on another head: load the review again for it.
  const head = tour?.headSha ?? null;
  const shownHead = useRef(head);
  const { reload } = review;
  useEffect(() => {
    const before = shownHead.current;
    shownHead.current = head;
    if (before !== null && head !== null && before !== head) void reload();
  }, [head, reload]);

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
    about.setOpen(false);
  }

  /** Opens a home from elsewhere (the review panel); on the current one, back to its code. */
  function openHome(homeId: string) {
    if (homeId === current) setJump(null);
    else goTo(homeId);
  }

  const index = current === null ? -1 : ids.indexOf(current);
  const previousId = index > 0 ? ids[index - 1] : undefined;
  const previousFlowId = current === null ? undefined : previousFlowStart(homes, current);
  const nextFlowId = current === null ? undefined : nextFlowStart(homes, current);

  function nextStep() {
    const next = ids[index + 1];
    if (next !== undefined) goTo(next);
    // On the last home there is nowhere to go; j still says "done with this one".
    else if (current !== null) markLeft(current);
    about.setOpen(false);
  }

  // Keys and the step pane's buttons do the same moves; undefined means nowhere to go.
  const nav = {
    previousStep: previousId === undefined ? undefined : () => goTo(previousId),
    nextStep,
    previousFlow: previousFlowId === undefined ? undefined : () => goTo(previousFlowId),
    nextFlow: nextFlowId === undefined ? undefined : () => goTo(nextFlowId),
  };

  useKeys({
    j: nextStep,
    k: () => nav.previousStep?.(),
    '[': () => nav.previousFlow?.(),
    ']': () => nav.nextFlow?.(),
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
  const notices = (tour && outdated) || build.state !== 'idle' || !tour || seenError;

  return (
    <ComposerMemoryContext.Provider value={memory}>
      <div className="tour-app">
        <TopBar
          pr={summary}
          tour={tour}
          isSeen={isSeen}
          aboutOpen={about.open}
          onAboutChange={about.setOpen}
          review={review}
          onOpenHome={openHome}
          onJump={(file, line) => setJump({ file, line })}
        />

        {notices && (
          <div className="notices">
            {tour && outdated && (
              <div className="banner">
                <span>New commits since this tour was built</span>
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
              build.state !== 'idle' && (
                <BuildStatus
                  build={build}
                  onRetry={startBuild}
                  onConfirm={confirmReplace}
                  onCancel={cancelReplace}
                />
              )
            ) : (
              <section className="build-panel">
                <p>There is no tour for this pull request yet.</p>
                {build.state === 'idle' ? (
                  <button type="button" className="primary" onClick={startBuild}>
                    Build tour
                  </button>
                ) : (
                  <BuildStatus
                    build={build}
                    onRetry={startBuild}
                    onConfirm={confirmReplace}
                    onCancel={cancelReplace}
                  />
                )}
              </section>
            )}
            {seenError && (
              <p className="error seen-error" role="status">
                {seenError}
              </p>
            )}
          </div>
        )}

        {tour && current !== null && currentHome && (
          <div className="tour-body">
            <Outline
              tour={tour}
              currentId={current}
              isSeen={isSeen}
              onSelect={goTo}
              previousFlow={nav.previousFlow}
              nextFlow={nav.nextFlow}
            />
            <main className="tour-main">
              <StepPane
                repo={repo}
                pr={pr}
                tour={tour}
                home={currentHome}
                jump={jump}
                onJump={(file, line) => setJump({ file, line })}
                onBack={() => setJump(null)}
                onOpenHome={goTo}
                nav={nav}
                review={review}
              />
            </main>
          </div>
        )}
      </div>
    </ComposerMemoryContext.Provider>
  );
}
