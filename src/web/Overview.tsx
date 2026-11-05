import { useEffect, useId, useState, type ComponentProps, type ReactNode, type Ref } from 'react';
import type { Flow, Tour } from '../shared/tour.js';
import { otherGroupsInOrder } from './homes.js';
import { MapWithPeek, type PeekState } from './MapWithPeek.js';

/** What a card's peek needs that is not about the step; "Open in tour" is `onVisit`. */
export type OverviewPeekProps = Omit<
  ComponentProps<typeof MapWithPeek>['peekProps'],
  'onOpenInTour'
>;

type Props = {
  tour: Tour;
  /** The PR title, shown as the overview's title. */
  title: string;
  /** True once the reader has seen any home: the start button says "Continue the tour". */
  started: boolean;
  /** The home the tour is on (marked in the maps); null before the reader started. */
  currentId: string | null;
  onStart: () => void;
  /** The one peek open on the overview (null: none); a card shows it when it is of its flow. */
  peek: PeekState | null;
  onPeek: (peek: PeekState | null) => void;
  peekProps: OverviewPeekProps;
  /** Shows a home in the tour as a visit, with a way back here: the strip, the rest, a peek. */
  onVisit: (homeId: string) => void;
  /** The overview region: focus goes to it when the reader opens the overview. */
  regionRef?: Ref<HTMLElement>;
  /** Kept mounted but hidden during a visit, so it comes back as it was. */
  hidden?: boolean;
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What the PR does before the step-by-step tour: its flows with their maps, and the rest. */
export function Overview({
  tour,
  title,
  started,
  currentId,
  onStart,
  peek,
  onPeek,
  peekProps,
  onVisit,
  regionRef,
  hidden = false,
}: Props): ReactNode {
  const flowsHead = useId();
  const start = (
    <button type="button" className="primary overview-start" onClick={onStart}>
      {started ? 'Continue the tour' : 'Start the tour'}
    </button>
  );

  return (
    <section
      className="overview"
      aria-label="Overview"
      tabIndex={-1}
      ref={regionRef}
      hidden={hidden}
    >
      <div className="overview-head">
        <h2 className="overview-title">{title}</h2>
        {start}
      </div>
      <p className="overview-summary">{tour.summary}</p>
      {tour.flows.length > 0 && (
        <section className="overview-flows" aria-labelledby={flowsHead}>
          <h3 id={flowsHead}>Flows in this PR ({tour.flows.length})</h3>
          {tour.flows.map((flow, i) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              no={i + 1}
              startsOpen={i === 0}
              currentId={currentId}
              peek={peek}
              onPeek={onPeek}
              peekProps={peekProps}
              onVisit={onVisit}
              shown={!hidden}
            />
          ))}
        </section>
      )}
      <Rest tour={tour} onVisit={onVisit} />
      <div className="overview-foot">{start}</div>
    </section>
  );
}

function FlowCard({
  flow,
  no,
  startsOpen,
  currentId,
  peek,
  onPeek,
  peekProps,
  onVisit,
  shown,
}: {
  flow: Flow;
  /** The flow's 1-based number in the tour. */
  no: number;
  startsOpen: boolean;
  currentId: string | null;
  peek: PeekState | null;
  onPeek: (peek: PeekState | null) => void;
  peekProps: OverviewPeekProps;
  onVisit: (homeId: string) => void;
  /** False while the overview is kept hidden during a visit. */
  shown: boolean;
}) {
  const [open, setOpen] = useState(startsOpen);
  // A peek in a hidden map would still take j, k and Esc: it closes with the map. Also when
  // Back brings back a peek of a card closed meanwhile. Only while the overview shows: the
  // hidden overview must not close the map panel's peek.
  const strayPeek = shown && !open && peek?.flowId === flow.id;
  useEffect(() => {
    if (strayPeek) onPeek(null);
  }, [strayPeek, onPeek]);
  const head = useId();
  const changed = flow.steps.filter((s) => s.homes.length > 0).length;
  const closely = flow.steps.filter((s) => s.risk === 'read-closely').length;
  const counts = [
    plural(flow.steps.length, 'step'),
    `${changed} changed`,
    closely > 0 && `${closely} read closely`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section className="overview-flow" aria-labelledby={head}>
      <h4 id={head} className="overview-flow-title">
        Flow {no} · {flow.title}
      </h4>
      <p className="overview-flow-entry">
        <code>{flow.entry.label}</code>
      </p>
      {flow.why !== undefined && <p className="overview-flow-why">{flow.why}</p>}
      <p className="overview-flow-counts">{counts}</p>
      <ol className="overview-strip" aria-label="Steps">
        {flow.steps.map((step, i) => {
          const looks = [
            step.homes.length > 0 ? 'changed' : 'unchanged',
            step.risk === 'read-closely' && 'read-closely',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li key={step.id}>
              <button
                type="button"
                className={`overview-step ${looks}`}
                title={step.title}
                onClick={() => onVisit(step.id)}
              >
                <span className="overview-step-no">{i + 1}</span>{' '}
                <span className="overview-step-title">{step.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="link-button overview-map-toggle"
        aria-expanded={open}
        // Each card has this button: the name says which flow's map it is.
        aria-label={`${open ? 'Hide' : 'Show'} the map of flow ${no}`}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide the map' : 'Show the map'}
      </button>
      {open && (
        <section className="overview-map" aria-label={`Flow ${no} map`}>
          <MapWithPeek
            place="card"
            flow={flow}
            currentId={currentId ?? ''}
            peek={peek}
            peekProps={{ ...peekProps, onOpenInTour: onVisit }}
            onPeek={onPeek}
            shown={shown}
          />
        </section>
      )}
    </section>
  );
}

/** "Also in this PR": foundations and each other-changes group, each linking to its first home. */
function Rest({ tour, onVisit }: { tour: Tour; onVisit: (homeId: string) => void }) {
  const parts: { label: string; homeId: string }[] = [];
  const firstFoundation = tour.foundations[0];
  if (firstFoundation) {
    parts.push({
      label: plural(tour.foundations.length, 'foundation'),
      homeId: firstFoundation.id,
    });
  }
  for (const group of otherGroupsInOrder(tour)) {
    const first = group.items[0];
    if (first) parts.push({ label: `${group.title} (${group.items.length})`, homeId: first.id });
  }
  if (parts.length === 0) return null;
  return (
    <p className="overview-rest">
      <span className="overview-rest-label">Also in this PR</span>
      {parts.map((part, i) => (
        <span key={part.homeId} className="overview-rest-part">
          {/* A dot between the parts, for the eye only. */}
          {i > 0 && (
            <>
              <span className="overview-rest-sep" aria-hidden="true">
                ·
              </span>{' '}
            </>
          )}
          <button type="button" className="link-button" onClick={() => onVisit(part.homeId)}>
            {part.label}
          </button>
        </span>
      ))}
    </p>
  );
}
