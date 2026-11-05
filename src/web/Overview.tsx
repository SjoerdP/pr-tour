import { useId, useState, type ReactNode } from 'react';
import type { Flow, Tour } from '../shared/tour.js';
import { FlowMap } from './FlowMap.js';
import { otherGroupsInOrder } from './homes.js';

type Props = {
  tour: Tour;
  /** The PR title, shown as the overview's title. */
  title: string;
  /** True once the reader has seen any home: the start button says "Continue the tour". */
  started: boolean;
  /** The home the tour is on (marked in the maps); null before the reader started. */
  currentId: string | null;
  onStart: () => void;
  onOpenHome: (homeId: string) => void;
  onOpenLine: (homeId: string, file: string, line: number) => void;
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
  onOpenHome,
  onOpenLine,
}: Props): ReactNode {
  const flowsHead = useId();
  const start = (
    <button type="button" className="primary overview-start" onClick={onStart}>
      {started ? 'Continue the tour' : 'Start the tour'}
    </button>
  );

  return (
    <div className="overview">
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
              onOpenHome={onOpenHome}
              onOpenLine={onOpenLine}
            />
          ))}
        </section>
      )}
      <Rest tour={tour} onOpenHome={onOpenHome} />
      <div className="overview-foot">{start}</div>
    </div>
  );
}

function FlowCard({
  flow,
  no,
  startsOpen,
  currentId,
  onOpenHome,
  onOpenLine,
}: {
  flow: Flow;
  /** The flow's 1-based number in the tour. */
  no: number;
  startsOpen: boolean;
  currentId: string | null;
  onOpenHome: (homeId: string) => void;
  onOpenLine: (homeId: string, file: string, line: number) => void;
}) {
  const [open, setOpen] = useState(startsOpen);
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
                onClick={() => onOpenHome(step.id)}
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
          <FlowMap
            flow={flow}
            currentId={currentId ?? ''}
            onOpenStep={onOpenHome}
            onOpenLine={onOpenLine}
          />
        </section>
      )}
    </section>
  );
}

/** "Also in this PR": foundations and each other-changes group, each linking to its first home. */
function Rest({ tour, onOpenHome }: { tour: Tour; onOpenHome: (homeId: string) => void }) {
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
      {parts.map((part) => (
        <span key={part.homeId} className="overview-rest-part">
          <button type="button" className="link-button" onClick={() => onOpenHome(part.homeId)}>
            {part.label}
          </button>
        </span>
      ))}
    </p>
  );
}
