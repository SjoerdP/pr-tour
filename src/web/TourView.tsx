import { useEffect, useMemo, useRef, useState } from 'react';
import { BuildStatus } from './BuildStatus.js';
import type { Reveal, RevealPlace } from './code-lines.js';
import { ComposerMemory, ComposerMemoryContext } from './composer-memory.js';
import { FlowMap } from './FlowMap.js';
import {
  flowStepAt,
  homesInOrder,
  nextFlowStart,
  openingPlace,
  previousFlowStart,
} from './homes.js';
import { Outline } from './Outline.js';
import { Overview } from './Overview.js';
import { StepPane } from './StepPane.js';
import { TopBar } from './TopBar.js';
import { useAboutPanel } from './useAboutPanel.js';
import { withKey } from './shortcuts.js';
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
  // The flow map over the step pane: shown only while the current home is a step.
  const [mapOpen, setMapOpen] = useState(false);
  const mapPanel = useRef<HTMLElement>(null);
  const mapButton = useRef<HTMLButtonElement>(null);
  // The overview of the PR, shown in place of the step pane.
  const [overviewOpen, setOverviewOpen] = useState(false);
  // The outline's order is the reading order: j/k walk the same list.
  const homes = useMemo(() => (tour ? homesInOrder(tour) : []), [tour]);
  const ids = useMemo(() => homes.map((h) => h.id), [homes]);
  // A new tour (first load, or a rebuild: new head or new build) closes the map, as its
  // flows may have changed, and opens where the reader left off: the overview when they have
  // not started, else the first home not seen. Taken once per tour: marks made while reading
  // do not move the reader.
  const tourKey = tour ? `${tour.headSha} ${tour.createdAt}` : null;
  const [shownTourKey, setShownTourKey] = useState<string | null>(null);
  if (shownTourKey !== tourKey) {
    setShownTourKey(tourKey);
    setMapOpen(false);
    if (tour) {
      const place = openingPlace(homes, isSeen);
      setOverviewOpen(place.overview);
      setCurrentId(place.homeId);
    }
  }
  // Where the code view scrolls to after a jump from the review panel (null: its own start).
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const revealSeq = useRef(0);
  const about = useAboutPanel(repo, pr, tour !== null);
  // Moving through the tour leaves the review panel open; the top bar opens and closes it.
  const [reviewChoice, setReviewChoice] = useState(false);
  const reviewOpen = tour !== null && reviewChoice;
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

  // After a rebuild the old id may be gone; fall back to the first home.
  const current = currentId !== null && ids.includes(currentId) ? currentId : (ids[0] ?? null);

  /**
   * Moving past a home marks it seen; opening one does not. Either way the overview closes.
   * Leaving the overview marks nothing: the reader was not reading the home the tour is on.
   */
  function goTo(homeId: string | undefined) {
    if (homeId === undefined) return;
    setOverviewOpen(false);
    if (current === null || homeId === current) return;
    if (!overviewOpen) markLeft(current);
    setCurrentId(homeId);
    setJump(null);
    setReveal(null);
    about.setOpen(false);
    setMapOpen(false);
  }

  /** Brings a place into view in the code (null: nothing in particular). */
  function show(at: RevealPlace | 'focus' | null) {
    // The map and the overview would hide the code being shown.
    setMapOpen(false);
    setOverviewOpen(false);
    revealSeq.current += 1;
    setReveal(at === null ? null : { at, seq: revealSeq.current });
  }

  /** Follows a traced call, or goes back from one: no place to bring into view. */
  function follow(to: { file: string; line: number } | null) {
    setJump(to);
    setReveal(null);
  }

  /**
   * Follows a call from the step's code. A call into another step of the same flow goes to
   * that step, so the outline moves along; any other call is a look from this step.
   */
  function followCall(file: string, line: number, toStep?: string | null) {
    const home = homes.find((h) => h.id === current);
    // A call site of the code check names its step (null: it has none, so only a look).
    const step =
      home?.kind !== 'step'
        ? undefined
        : toStep === undefined
          ? flowStepAt(home.flow, file, line)
          : home.flow.steps.find((s) => s.id === toStep);
    if (step && step.id !== current) goTo(step.id);
    else follow({ file, line });
  }

  /**
   * Opens a home from elsewhere (the review panel), showing `at` there, else its start; on
   * the current one, back to its code.
   */
  function openHome(homeId: string, at?: RevealPlace) {
    if (homeId === current) setJump(null);
    else goTo(homeId);
    show(at ?? 'focus');
  }

  const currentHome = homes.find((h) => h.id === current);
  const mapFlow = currentHome?.kind === 'step' ? currentHome.flow : null;
  // The overview takes the place of the step pane, so the map is never open over it.
  const mapShown = mapOpen && mapFlow !== null && !overviewOpen;
  // The map is a dialog: focus goes into it when it opens.
  useEffect(() => {
    if (mapShown) mapPanel.current?.focus();
  }, [mapShown]);

  /** Closes the map by Esc or Close, and puts focus back on the Flow map button. */
  function closeMap() {
    setMapOpen(false);
    mapButton.current?.focus();
  }

  /** Opens or closes the overview; opening it closes the map. */
  function toggleOverview() {
    if (!overviewOpen) setMapOpen(false);
    setOverviewOpen(!overviewOpen);
  }

  // Started: the reader has seen a home of this tour (the same rule as the opening place).
  const started = homes.some((h) => isSeen(h.id));

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
    // On the overview, j and k first show the home the tour is on, without moving.
    j: () => (overviewOpen ? setOverviewOpen(false) : nextStep()),
    k: () => (overviewOpen ? setOverviewOpen(false) : nav.previousStep?.()),
    // At the ends of the tour there is no flow to open; on the overview the key still closes it.
    '[': () => (nav.previousFlow ? nav.previousFlow() : setOverviewOpen(false)),
    ']': () => (nav.nextFlow ? nav.nextFlow() : setOverviewOpen(false)),
    ...(tour !== null ? { o: toggleOverview } : {}),
    ...(mapFlow !== null && !overviewOpen
      ? { m: () => (mapShown ? closeMap() : setMapOpen(true)) }
      : {}),
    // Esc closes the map first; then it goes back from a followed call to the step's own
    // code; then it closes the overview. A call followed before the overview opened is hidden
    // under it, so it waits until the overview is closed.
    ...(mapShown
      ? { Escape: closeMap }
      : jump && !overviewOpen
        ? { Escape: () => follow(null) }
        : overviewOpen
          ? { Escape: () => setOverviewOpen(false) }
          : {}),
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
  const notices = (tour && outdated) || build.state !== 'idle' || !tour || seenError;

  return (
    <ComposerMemoryContext.Provider value={memory}>
      {/* An open review panel takes a column on wide windows: see .review-open in the CSS. */}
      <div className={reviewOpen ? 'tour-app review-open' : 'tour-app'}>
        <TopBar
          pr={summary}
          tour={tour}
          isSeen={isSeen}
          overviewOpen={tour !== null && overviewOpen}
          onOverview={toggleOverview}
          aboutOpen={about.open}
          onAboutChange={about.setOpen}
          reviewOpen={reviewOpen}
          onReviewChange={setReviewChoice}
          review={review}
          onOpenHome={openHome}
          onJump={(file, line, at) => {
            setJump({ file, line });
            show(at ?? null);
          }}
        />

        {notices && (
          <div className="notices">
            {tour && outdated && (
              <div className="banner">
                <span>New commits since this tour was built</span>
                <button
                  type="button"
                  onClick={startBuild}
                  // While the replace confirm shows, its own Rebuild is the way on.
                  disabled={
                    build.state === 'starting' ||
                    build.state === 'running' ||
                    build.state === 'confirm'
                  }
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
              {overviewOpen ? (
                <Overview
                  tour={tour}
                  title={summary.title}
                  started={started}
                  currentId={started ? current : null}
                  onStart={() => setOverviewOpen(false)}
                  onOpenHome={(homeId) => openHome(homeId)}
                  onOpenLine={(homeId, file, line) =>
                    openHome(homeId, { path: file, side: 'new', line })
                  }
                />
              ) : (
                <StepPane
                  repo={repo}
                  pr={pr}
                  tour={tour}
                  home={currentHome}
                  jump={jump}
                  reveal={reveal}
                  onJump={followCall}
                  onShowLine={(file, line) => follow({ file, line })}
                  onRevealLine={(file, line) =>
                    openHome(currentHome.id, { path: file, side: 'new', line })
                  }
                  onBack={() => follow(null)}
                  onOpenHome={goTo}
                  onOpenMap={() => setMapOpen(true)}
                  mapButtonRef={mapButton}
                  nav={nav}
                  review={review}
                />
              )}
              {mapShown && mapFlow && (
                <section
                  className="flow-map-panel"
                  role="dialog"
                  aria-modal="true"
                  tabIndex={-1}
                  ref={mapPanel}
                  aria-label={`Flow map: ${mapFlow.title}`}
                >
                  <div className="flow-map-panel-head">
                    <h2 className="flow-map-panel-title">Flow map: {mapFlow.title}</h2>
                    <button type="button" onClick={closeMap} title={withKey('Close', 'Esc')}>
                      Close
                    </button>
                  </div>
                  {/* A fresh map per flow: fold choices never carry over. */}
                  <FlowMap
                    key={mapFlow.id}
                    flow={mapFlow}
                    currentId={current}
                    onOpenStep={(stepId) => {
                      goTo(stepId);
                      setMapOpen(false);
                    }}
                    onOpenLine={(stepId, file, line) =>
                      openHome(stepId, { path: file, side: 'new', line })
                    }
                  />
                </section>
              )}
            </main>
          </div>
        )}
      </div>
    </ComposerMemoryContext.Provider>
  );
}
