import { useEffect, useMemo, useRef, useState } from 'react';
import { BuildStatus } from './BuildStatus.js';
import type { Reveal, RevealPlace } from './code-lines.js';
import { ComposerMemory, ComposerMemoryContext } from './composer-memory.js';
import {
  flowStepAt,
  homesInOrder,
  nextFlowStart,
  openingPlace,
  previousFlowStart,
} from './homes.js';
import { MapWithPeek, type PeekState } from './MapWithPeek.js';
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

/** A step shown from the map panel or the overview, and the way back there. */
type Visit = {
  /** What the back button reopens. */
  back: 'map' | 'overview';
  /** The home the tour was on before the first visit: going back returns there. */
  place: string;
  /** The peek that was open, opened again on the way back. */
  peek: PeekState | null;
  /** For the map: the flow it showed. */
  mapFlowId: string | null;
};

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
  // The map panel's flow when it is not the current step's: after Back to a map of another flow.
  const [mapFlowId, setMapFlowId] = useState<string | null>(null);
  // The overview of the PR, shown in place of the step pane.
  const [overviewOpen, setOverviewOpen] = useState(false);
  // The one peek open in the map panel or on the overview: a look, never a move.
  const [peek, setPeek] = useState<PeekState | null>(null);
  // A step shown from the map or the overview ("Open in tour"), with the way back: `place` is
  // the home the tour was on before the first visit, `back` and `peek` what to reopen.
  const [visit, setVisit] = useState<Visit | null>(null);
  // Set when a visit starts: focus goes to the visited step (see the effect below).
  const paneFocus = useRef(false);
  const overviewPanel = useRef<HTMLElement>(null);
  const stepPane = useRef<HTMLElement>(null);
  // Set when the reader opens or leaves the overview: focus follows (see the effect below).
  // A new tour that opens or closes it moves no focus.
  const overviewFocus = useRef(false);
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
    setMapFlowId(null);
    setPeek(null);
    setVisit(null);
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

  /** Closes the map panel and its peek. */
  function hideMap() {
    setMapOpen(false);
    setMapFlowId(null);
    setPeek(null);
  }

  /**
   * Moving past a home marks it seen; opening one does not. Either way the overview closes.
   * Leaving the overview marks nothing: the reader was not reading the home the tour is on.
   * A move to another home ends a visit: the visited step is the reader's place now.
   */
  function goTo(homeId: string | undefined) {
    if (homeId === undefined) return;
    setOverviewOpen(false);
    setPeek(null);
    if (current === null || homeId === current) return;
    if (!overviewOpen) markLeft(current);
    setCurrentId(homeId);
    setVisit(null);
    setJump(null);
    setReveal(null);
    about.setOpen(false);
    hideMap();
  }

  /** Brings a place into view in the code (null: nothing in particular). */
  function show(at: RevealPlace | 'focus' | null) {
    // The map and the overview would hide the code being shown.
    hideMap();
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
  const flowById = (id: string | null) =>
    id === null ? undefined : tour?.flows.find((f) => f.id === id);
  const mapFlow = flowById(mapFlowId) ?? (currentHome?.kind === 'step' ? currentHome.flow : null);
  // The overview takes the place of the step pane, so the map is never open over it.
  const mapShown = mapOpen && mapFlow !== null && !overviewOpen;
  // The peek on screen: the one in the shown map panel or on the shown overview.
  const peekShown = peek !== null && (mapShown || overviewOpen) ? peek : null;
  // The map is a dialog: focus goes into it when it opens.
  useEffect(() => {
    if (mapShown) mapPanel.current?.focus();
  }, [mapShown]);

  // A visit shows the visited step: focus goes to it, so Tab goes on from there.
  useEffect(() => {
    if (!paneFocus.current) return;
    paneFocus.current = false;
    stepPane.current?.focus();
  }, [visit]);

  /**
   * Opens the map without a peek; during a visit from this same map, with the peek the visit
   * keeps, so it is the same peek, not a fresh one.
   */
  function openMap() {
    const again = visit?.back === 'map' && mapFlow?.id === visit.mapFlowId;
    setPeek(again ? visit.peek : null);
    setMapOpen(true);
  }

  /** Closes the map by Esc or Close, and puts focus back on the Flow map button. */
  function closeMap() {
    hideMap();
    (mapButton.current ?? stepPane.current)?.focus();
  }

  /**
   * Opens or closes the overview; opening it closes the map. During a visit from the overview
   * it opens with the peek the visit keeps.
   */
  function toggleOverview() {
    if (!overviewOpen) hideMap();
    setPeek(!overviewOpen && visit?.back === 'overview' ? visit.peek : null);
    overviewFocus.current = true;
    setOverviewOpen(!overviewOpen);
  }

  /** The reader leaves the overview (if it is open): focus goes to the step. */
  function closeOverview() {
    if (overviewOpen) {
      overviewFocus.current = true;
      setPeek(null);
    }
    setOverviewOpen(false);
  }

  /**
   * "Open in tour" from the map panel or the overview: shows that home without marking
   * anything, and keeps the way back. A visit during a visit keeps the first place.
   */
  function visitHome(homeId: string, back: Visit['back']) {
    const place = visit?.place ?? current;
    if (place === null) return;
    setVisit({
      back,
      place,
      peek: peekShown,
      mapFlowId: back === 'map' && mapFlow ? mapFlow.id : null,
    });
    setCurrentId(homeId);
    setJump(null);
    // A peek of a calling line opens the step at that line, as the arrow used to.
    const home = homes.find((h) => h.id === homeId);
    if (peekShown?.stepId === homeId && peekShown.line !== null && home?.kind === 'step') {
      revealSeq.current += 1;
      setReveal({
        at: { path: home.step.file, side: 'new', line: peekShown.line },
        seq: revealSeq.current,
      });
    } else {
      setReveal(null);
    }
    about.setOpen(false);
    setMapOpen(false);
    setMapFlowId(null);
    setOverviewOpen(false);
    setPeek(null);
    paneFocus.current = true;
  }

  /** Ends a visit where it began: the old place, the map or overview, the same peek. */
  function goBack() {
    if (!visit) return;
    setCurrentId(visit.place);
    setJump(null);
    setReveal(null);
    setPeek(visit.peek);
    if (visit.back === 'map') {
      setMapFlowId(visit.mapFlowId);
      setMapOpen(true);
    } else {
      overviewFocus.current = true;
      setOverviewOpen(true);
    }
    setVisit(null);
  }

  /**
   * Opens, moves or closes the peek. A peek that closes with focus in it hands focus to the
   * map panel or the overview around it, so the keys and Tab go on from there. Focus anywhere
   * else (a card's "Hide the map", a box in the map) stays where it is.
   */
  function changePeek(next: PeekState | null) {
    if (next === null && peekShown) {
      const region = mapShown ? mapPanel.current : overviewPanel.current;
      // The peek's part of the map: it goes away with the peek, "← Map" included.
      const going = document.activeElement?.closest('.map-peek-peek');
      if (going && region?.contains(going)) region.focus();
    }
    setPeek(next);
  }

  /** Moves the open peek along its flow's steps; at the ends it stays. */
  function movePeek(by: 1 | -1) {
    if (!peekShown) return;
    const steps = flowById(peekShown.flowId)?.steps ?? [];
    const to = steps[steps.findIndex((s) => s.id === peekShown.stepId) + by];
    if (to) setPeek({ flowId: peekShown.flowId, stepId: to.id, line: null });
  }

  /** j / k on the map panel without a peek: a peek of the step the tour is on. */
  function peekCurrent() {
    if (!mapFlow) return;
    const step = mapFlow.steps.find((s) => s.id === current) ?? mapFlow.steps[0];
    if (step) setPeek({ flowId: mapFlow.id, stepId: step.id, line: null });
  }

  // Focus goes into the overview when the reader opens it, and to the step when they leave
  // it, so Tab goes on from there. Only on a change the reader made, never on a re-render.
  useEffect(() => {
    if (!overviewFocus.current) return;
    overviewFocus.current = false;
    (overviewOpen ? overviewPanel : stepPane).current?.focus();
  }, [overviewOpen]);

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
    // The map panel and the overview never move the tour: with a peek, j and k move the peek;
    // on the map without one, they peek at the step the tour is on; on the overview without
    // one, they show the home the tour is on.
    j: () =>
      peekShown
        ? movePeek(1)
        : mapShown
          ? peekCurrent()
          : overviewOpen
            ? closeOverview()
            : nextStep(),
    k: () =>
      peekShown
        ? movePeek(-1)
        : mapShown
          ? peekCurrent()
          : overviewOpen
            ? closeOverview()
            : nav.previousStep?.(),
    // At the ends of the tour there is no flow to open; on the overview the key still closes it.
    '[': () => {
      closeOverview();
      nav.previousFlow?.();
    },
    ']': () => {
      closeOverview();
      nav.nextFlow?.();
    },
    ...(tour !== null ? { o: toggleOverview } : {}),
    ...(mapFlow !== null && !overviewOpen ? { m: () => (mapShown ? closeMap() : openMap()) } : {}),
    // Esc closes a peek first, then the map; then it goes back from a followed call to the
    // step's own code; then it closes the overview; then it ends a visit. A call followed
    // before the overview opened is hidden under it, so it waits until the overview is closed.
    ...(peekShown
      ? { Escape: () => changePeek(null) }
      : mapShown
        ? { Escape: closeMap }
        : jump && !overviewOpen
          ? { Escape: () => follow(null) }
          : overviewOpen
            ? { Escape: closeOverview }
            : visit
              ? { Escape: goBack }
              : {}),
  });

  // What every peek needs that is not about the step. Marking a step seen moves nothing.
  const peekProps = { repo, pr, review, isSeen, onMarkSeen: markLeft };
  // The map panel on screen, or the one a visit goes back to (hidden meanwhile).
  const panelFlow = mapShown
    ? mapFlow
    : visit?.back === 'map'
      ? (flowById(visit.mapFlowId) ?? null)
      : null;

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
              onSelect={(homeId) => {
                closeOverview();
                goTo(homeId);
              }}
              previousFlow={nav.previousFlow}
              nextFlow={nav.nextFlow}
            />
            <main className="tour-main">
              {/* Kept, hidden, during a visit from it: it comes back as it was. */}
              {(overviewOpen || visit?.back === 'overview') && (
                <Overview
                  regionRef={overviewPanel}
                  hidden={!overviewOpen}
                  tour={tour}
                  title={summary.title}
                  started={started}
                  currentId={started ? current : null}
                  onStart={closeOverview}
                  peek={overviewOpen ? peek : (visit?.peek ?? null)}
                  onPeek={changePeek}
                  peekProps={{ ...peekProps, tour, keys: overviewOpen && peekShown !== null }}
                  onVisit={(homeId) => visitHome(homeId, 'overview')}
                />
              )}
              {!overviewOpen && (
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
                  onOpenMap={openMap}
                  mapButtonRef={mapButton}
                  paneRef={stepPane}
                  nav={nav}
                  review={review}
                  // The map covers the step: n / p / f are the peek's then.
                  codeKeys={!mapShown}
                  {...(visit && {
                    back: {
                      label: visit.back === 'map' ? 'Back to the map' : 'Back to the overview',
                      go: goBack,
                      // The same order as the Esc key above: a followed call goes first.
                      byEsc: !peekShown && !mapShown && !jump,
                    },
                  })}
                />
              )}
              {/* Kept, hidden, during a visit from it: it comes back as it was. */}
              {panelFlow && (
                <section
                  className="flow-map-panel"
                  role="dialog"
                  aria-modal="true"
                  tabIndex={-1}
                  ref={mapPanel}
                  aria-label={`Flow map: ${panelFlow.title}`}
                  hidden={!mapShown}
                >
                  <div className="flow-map-panel-head">
                    <h2 className="flow-map-panel-title">Flow map: {panelFlow.title}</h2>
                    <button type="button" onClick={closeMap} title={withKey('Close', 'Esc')}>
                      Close
                    </button>
                  </div>
                  <MapWithPeek
                    place="panel"
                    flow={panelFlow}
                    currentId={mapShown ? current : (visit?.place ?? current)}
                    peek={mapShown ? peek : (visit?.peek ?? null)}
                    peekProps={{
                      ...peekProps,
                      tour,
                      keys: mapShown && peekShown !== null,
                      onOpenInTour: (stepId) => visitHome(stepId, 'map'),
                    }}
                    onPeek={changePeek}
                    shown={mapShown}
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
