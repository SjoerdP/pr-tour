import { Fragment, useId, useState, type ReactNode } from 'react';
import {
  lastChangedStepIndex,
  type Flow,
  type Foundation,
  type OtherGroup,
  type Risk,
  type SideEffect,
  type Tour,
} from '../shared/tour.js';
import { otherGroupsInOrder } from './homes.js';
import { keepsReviewOpen } from './keep-review-open.js';
import { withKey } from './shortcuts.js';

type Props = {
  tour: Tour;
  currentId: string;
  isSeen: (homeId: string) => boolean;
  onSelect: (homeId: string) => void;
  /** Go to the first step of the previous or next flow; undefined when there is none. */
  previousFlow: (() => void) | undefined;
  nextFlow: (() => void) | undefined;
};

type ItemProps = {
  currentId: string;
  isSeen: (homeId: string) => boolean;
  onSelect: (homeId: string) => void;
};

/**
 * A card opened or shut by hand. The choice holds while the reader stays in the section
 * (`at`: the foundations, one flow, or the other changes) where it was made; moving into
 * another section goes back to "the card with the current item is open".
 */
type Choice<T> = { at: string; value: T } | null;

/** The section the current item is in: 'foundations', a flow id, or 'other'. */
function sectionOf(tour: Tour, currentId: string): string {
  if (tour.foundations.some((f) => f.id === currentId)) return 'foundations';
  return tour.flows.find((flow) => flow.steps.some((s) => s.id === currentId))?.id ?? 'other';
}

/** "seen / total" over the reviewable homes (those with changed lines) among `homes`. */
function progress(
  homes: Array<{ id: string; homes: unknown[] }>,
  isSeen: (homeId: string) => boolean,
): { seen: number; total: number } {
  const reviewable = homes.filter((h) => h.homes.length > 0);
  return { seen: reviewable.filter((h) => isSeen(h.id)).length, total: reviewable.length };
}

/** The tour's table of contents: foundations, then flows, then other changes. */
export function Outline({ tour, currentId, isSeen, onSelect, previousFlow, nextFlow }: Props) {
  const other = otherGroupsInOrder(tour);
  const itemProps = { currentId, isSeen, onSelect };
  const section = sectionOf(tour, currentId);

  const [foundationsChoice, setFoundationsChoice] = useState<Choice<boolean>>(null);
  const [flowChoice, setFlowChoice] = useState<Choice<string | null>>(null);
  const foundationsOpen =
    foundationsChoice?.at === section ? foundationsChoice.value : section === 'foundations';
  const currentFlow = tour.flows.some((f) => f.id === section) ? section : null;
  const openFlow = flowChoice?.at === section ? flowChoice.value : currentFlow;

  const flowProgress = progress(
    tour.flows.flatMap((f) => f.steps),
    isSeen,
  );
  const otherProgress = progress(
    other.flatMap((g) => g.items),
    isSeen,
  );

  return (
    <nav className="outline" aria-label="Tour outline" {...keepsReviewOpen}>
      {tour.foundations.length > 0 && (
        <section className="outline-section">
          <SectionHead title="Foundations" {...progress(tour.foundations, isSeen)} />
          <FoundationsCard
            foundations={tour.foundations}
            open={foundationsOpen}
            current={section === 'foundations'}
            onToggle={() => setFoundationsChoice({ at: section, value: !foundationsOpen })}
            {...itemProps}
          />
        </section>
      )}

      {tour.flows.length > 0 && (
        <section className="outline-section">
          <SectionHead title="Flows" {...flowProgress} />
          <div className="flow-nav">
            <button
              type="button"
              onClick={previousFlow}
              disabled={previousFlow === undefined}
              title={withKey('Previous flow', '[')}
            >
              Previous flow
            </button>
            <button
              type="button"
              onClick={nextFlow}
              disabled={nextFlow === undefined}
              title={withKey('Next flow', ']')}
            >
              Next flow
            </button>
          </div>
          {tour.flows.map((flow, i) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              number={i + 1}
              open={openFlow === flow.id}
              current={currentFlow === flow.id}
              onToggle={() =>
                setFlowChoice({ at: section, value: openFlow === flow.id ? null : flow.id })
              }
              {...itemProps}
            />
          ))}
        </section>
      )}

      {other.length > 0 && (
        <section className="outline-section">
          <SectionHead title="Other changes" {...otherProgress} />
          {other.map((group, i) => (
            <Group key={`${group.kind}-${i}`} group={group} {...itemProps} />
          ))}
        </section>
      )}
    </nav>
  );
}

function SectionHead({ title, seen, total }: { title: string; seen: number; total: number }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      <span className="section-progress">
        {seen} / {total} seen
      </span>
    </div>
  );
}

/** A card's header: a button that opens and shuts it, inside a heading. */
function CardHead({
  open,
  controls,
  onToggle,
  children,
}: {
  open: boolean;
  controls: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <h3 className="card-head">
      <button
        type="button"
        className="card-toggle"
        aria-expanded={open}
        aria-controls={open ? controls : undefined}
        onClick={onToggle}
      >
        <span className="chev" aria-hidden="true" />
        {children}
      </button>
    </h3>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function FoundationsCard({
  foundations,
  open,
  current,
  onToggle,
  ...itemProps
}: {
  foundations: Foundation[];
  open: boolean;
  current: boolean;
  onToggle: () => void;
} & ItemProps) {
  const listId = useId();
  const kinds = [...new Set(foundations.map((f) => f.kind))];
  const title = capitalize(kinds.join(', '));
  const readClosely = foundations.filter((f) => f.risk === 'read-closely').length;
  const count = foundations.length;

  return (
    <div className={`card${current ? ' card-current' : ''}`}>
      <CardHead open={open} controls={listId} onToggle={onToggle}>
        <span className="card-title">{title}</span>{' '}
        <span className="card-meta">
          {count} {count === 1 ? 'item' : 'items'}
          {readClosely > 0 && (
            <>
              {' · '}
              {readClosely} <span className="rc-dot" aria-hidden="true" />
              <span className="sr-only">read closely</span>
            </>
          )}
        </span>
      </CardHead>
      {open && (
        <ul id={listId} className="card-list">
          {foundations.map((f) => (
            <Item key={f.id} id={f.id} title={f.title} risk={f.risk} {...itemProps} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FlowCard({
  flow,
  number,
  open,
  current,
  onToggle,
  ...itemProps
}: {
  flow: Flow;
  number: number;
  open: boolean;
  current: boolean;
  onToggle: () => void;
} & ItemProps) {
  const bodyId = useId();
  // Steps after the last change are context: dimmed, below a divider.
  const lastChanged = lastChangedStepIndex(flow);
  const { seen, total } = progress(flow.steps, itemProps.isSeen);

  return (
    <div className={`card${current ? ' card-current' : ''}`}>
      <CardHead open={open} controls={bodyId} onToggle={onToggle}>
        <span className="card-num">{number}</span>{' '}
        <span className="card-title" title={flow.title}>
          {flow.title}
        </span>{' '}
        <span className="card-meta">{total === 0 ? 'no changes' : `${seen} / ${total}`}</span>
      </CardHead>
      {open && (
        <div id={bodyId} className="card-body">
          <p className="entry" title={flow.entry.label}>
            {flow.entry.label}
          </p>
          {lastChanged === -1 && flow.steps.length > 0 && (
            <p className="flow-end-note">No changes in this flow</p>
          )}
          <ul className="card-list">
            {flow.steps.map((step, i) => (
              <Fragment key={step.id}>
                <Item
                  id={step.id}
                  title={step.title}
                  dot={step.homes.length > 0 ? 'changed' : 'unchanged'}
                  risk={step.risk}
                  sideEffects={step.sideEffects}
                  afterChanges={i > lastChanged}
                  {...itemProps}
                />
                {i === lastChanged && i < flow.steps.length - 1 && (
                  <li role="separator" className="flow-end-divider">
                    no more changes
                  </li>
                )}
              </Fragment>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Group({ group, ...itemProps }: { group: OtherGroup } & ItemProps) {
  const bodyId = useId();
  // `null` until the user toggles: then their choice wins, also over the current item.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  // By default a group is shut, but never hides the item being read (j/k can land inside).
  // Unexplained changes are a warning the reader must see: that group starts open.
  const open =
    expanded ??
    (group.kind === 'unexplained' || group.items.some((item) => item.id === itemProps.currentId));

  return (
    <div className={`outline-group outline-group-${group.kind}`}>
      <CardHead open={open} controls={bodyId} onToggle={() => setExpanded(!open)}>
        <span className="card-title" title={group.summary}>
          {group.title}
        </span>{' '}
        {group.kind === 'generated' && (
          <>
            <span className="skim">skim</span>{' '}
          </>
        )}
        <span className="card-meta">{group.items.length}</span>
      </CardHead>
      {open && (
        <div id={bodyId} className="group-body">
          <p className="group-summary">{group.summary}</p>
          <ul className="card-list">
            {group.items.map((item) => (
              <Item key={item.id} id={item.id} title={item.title} {...itemProps} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Short words for side effects in the outline. */
const EFFECT_WORDS: Record<SideEffect['kind'], string> = {
  'db-write': 'db',
  event: 'event',
  'external-call': 'ext',
};

/** Side effects grouped by kind, in first-seen order: one word each, with all their labels. */
function effectWords(effects: SideEffect[]): Array<{ word: string; labels: string[] }> {
  const byKind = new Map<SideEffect['kind'], string[]>();
  for (const e of effects) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.label]);
  return [...byKind].map(([kind, labels]) => ({
    word: labels.length > 1 ? `${EFFECT_WORDS[kind]} ×${labels.length}` : EFFECT_WORDS[kind],
    labels,
  }));
}

function Item({
  id,
  title,
  dot,
  risk,
  sideEffects = [],
  afterChanges = false,
  currentId,
  isSeen,
  onSelect,
}: {
  id: string;
  title: string;
  /** Flow steps only: filled when the step has changes, hollow for unchanged context. */
  dot?: 'changed' | 'unchanged';
  risk?: Risk;
  sideEffects?: SideEffect[];
  /** A flow step after the flow's last change: shown dimmed. */
  afterChanges?: boolean;
} & ItemProps) {
  const current = id === currentId;
  const seen = isSeen(id);
  const classes = [seen && 'seen', afterChanges && 'after-changes'].filter(Boolean).join(' ');
  return (
    <li className={classes || undefined}>
      <button
        type="button"
        className="outline-item"
        aria-current={current ? 'step' : undefined}
        title={title}
        onClick={() => onSelect(id)}
      >
        {dot === 'changed' && <span className="dot" aria-hidden="true" />}
        {dot === 'unchanged' && (
          <span className="dot dot-hollow" role="img" aria-label="unchanged" />
        )}
        <span className="outline-item-title">{title}</span>
        {seen && <span className="sr-only" role="img" aria-label="seen" />}
        {effectWords(sideEffects).map(({ word, labels }) => (
          <span key={word} className="fx" title={labels.join('; ')}>
            {word}
          </span>
        ))}
        {risk === 'read-closely' &&
          (current ? (
            <span className="rc">
              <span className="rc-dot" aria-hidden="true" />
              <span className="rc-word">read closely</span>
            </span>
          ) : (
            <span className="rc" title="Read closely">
              <span className="rc-dot" aria-hidden="true" />
              <span className="sr-only">read closely</span>
            </span>
          ))}
      </button>
    </li>
  );
}
