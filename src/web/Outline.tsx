import { Fragment, useId, useState } from 'react';
import {
  lastChangedStepIndex,
  type OtherGroup,
  type Risk,
  type SideEffect,
  type Tour,
} from '../shared/tour.js';
import { otherGroupsInOrder } from './homes.js';

type Props = {
  tour: Tour;
  currentId: string;
  isSeen: (homeId: string) => boolean;
  onSelect: (homeId: string) => void;
};

/** Groups shut by default: generated code is skim-only, refactors read from their summary. */
const COLLAPSED_BY_DEFAULT: ReadonlySet<OtherGroup['kind']> = new Set(['generated', 'refactor']);

/** The tour's table of contents: foundations, then flows, then other changes. */
export function Outline({ tour, currentId, isSeen, onSelect }: Props) {
  const other = otherGroupsInOrder(tour);
  const itemProps = { currentId, isSeen, onSelect };

  return (
    <nav className="outline" aria-label="Tour outline">
      <p className="outline-source muted">
        {tour.source === 'author' ? 'Notes by the author' : 'Notes inferred by Claude'}
      </p>

      {tour.foundations.length > 0 && (
        <section>
          <h2>Foundations</h2>
          <ul>
            {tour.foundations.map((f) => (
              <Item key={f.id} id={f.id} title={f.title} risk={f.risk} {...itemProps} />
            ))}
          </ul>
        </section>
      )}

      {tour.flows.length > 0 && (
        <section>
          <h2>Flows</h2>
          {tour.flows.map((flow) => {
            // Steps after the last change are context: dimmed, below a divider.
            const lastChanged = lastChangedStepIndex(flow);
            return (
              <div key={flow.id} className="outline-flow">
                <h3>{flow.title}</h3>
                <p className="muted entry">{flow.entry.label}</p>
                {lastChanged === -1 && flow.steps.length > 0 && (
                  <p className="flow-end-note">No changes in this flow</p>
                )}
                <ul>
                  {flow.steps.map((step, i) => (
                    <Fragment key={step.id}>
                      <Item
                        id={step.id}
                        title={step.title}
                        changed={step.changed}
                        risk={step.risk}
                        sideEffects={step.sideEffects}
                        afterChanges={i > lastChanged}
                        {...itemProps}
                      />
                      {i === lastChanged && i < flow.steps.length - 1 && (
                        <li role="separator" className="flow-end-divider">
                          No more changes in this flow
                        </li>
                      )}
                    </Fragment>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}

      {other.length > 0 && (
        <section>
          <h2>Other changes</h2>
          {other.map((group, i) => (
            <Group key={`${group.kind}-${i}`} group={group} {...itemProps} />
          ))}
        </section>
      )}

      {tour.check.problems.length > 0 && (
        <details className="check-problems">
          <summary>
            {tour.check.problems.length}{' '}
            {tour.check.problems.length === 1 ? 'check problem' : 'check problems'}
          </summary>
          <ul>
            {tour.check.problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </details>
      )}
    </nav>
  );
}

type ItemProps = {
  currentId: string;
  isSeen: (homeId: string) => boolean;
  onSelect: (homeId: string) => void;
};

function Group({ group, ...itemProps }: { group: OtherGroup } & ItemProps) {
  const listId = useId();
  const collapsible = COLLAPSED_BY_DEFAULT.has(group.kind);
  // `null` until the user toggles: then their choice wins, also over the current item.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  // By default a group never hides the item being read (j/k can land inside a shut group).
  const open =
    expanded ?? (!collapsible || group.items.some((item) => item.id === itemProps.currentId));

  return (
    <div className={`outline-group outline-group-${group.kind}`}>
      <h3>
        {collapsible ? (
          <button
            type="button"
            className="group-toggle"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setExpanded(!open)}
          >
            {open ? '▾' : '▸'} {group.title}
          </button>
        ) : (
          group.title
        )}
        {group.kind === 'generated' && <span className="tag">skim only</span>}
      </h3>
      {(group.kind === 'refactor' || group.kind === 'unexplained') && (
        <p className="muted group-summary">{group.summary}</p>
      )}
      {open && (
        <ul id={listId}>
          {group.items.map((item) => (
            <Item key={item.id} id={item.id} title={item.title} {...itemProps} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Item({
  id,
  title,
  changed,
  risk,
  sideEffects = [],
  afterChanges = false,
  currentId,
  isSeen,
  onSelect,
}: {
  id: string;
  title: string;
  changed?: boolean;
  risk?: Risk;
  sideEffects?: SideEffect[];
  /** A flow step after the flow's last change: shown dimmed. */
  afterChanges?: boolean;
} & ItemProps) {
  const current = id === currentId;
  return (
    <li className={afterChanges ? 'after-changes' : undefined}>
      <button
        type="button"
        className="outline-item"
        aria-current={current ? 'step' : undefined}
        onClick={() => onSelect(id)}
      >
        <span className="seen-mark">
          {isSeen(id) && (
            <span role="img" aria-label="seen">
              ✓
            </span>
          )}
        </span>
        <span className="outline-item-title">{title}</span>
        {changed !== undefined && (
          <span className={changed ? 'tag' : 'tag tag-quiet'}>
            {changed ? 'changed' : 'unchanged'}
          </span>
        )}
        {risk === 'read-closely' && <span className="tag tag-warn">read closely</span>}
        {sideEffects.map((effect, i) => (
          <span key={i} className="tag tag-effect" title={effect.label}>
            {effect.kind}
          </span>
        ))}
      </button>
    </li>
  );
}
