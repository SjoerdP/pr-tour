import { useMemo, type ReactNode } from 'react';
import type { Flow, Tour } from '../shared/tour.js';
import type { Reveal } from './code-lines.js';
import { CodeView } from './CodeView.js';
import { cameFrom } from './homes.js';
import { effectWords } from './Outline.js';
import { withKey } from './shortcuts.js';
import { CAME_FROM_LABEL, codeTarget, proofTag } from './StepPane.js';
import type { ReviewState } from './useReview.js';

/** Tells one reveal from the next, so a second peek at the same line flashes again. */
let revealSeq = 0;

type Props = {
  repo: string;
  pr: number;
  tour: Tour;
  flow: Flow;
  stepId: string;
  /** A calling line to bring into view and flash; null for the step's start. */
  line: number | null;
  seen: boolean;
  /** CodeView's keys: true only for the peek that should answer n / p / f. */
  keys: boolean;
  review: ReviewState;
  onMove: (stepId: string, line: number | null) => void;
  onMarkSeen: (stepId: string) => void;
  onOpenInTour: (stepId: string) => void;
  onClose: () => void;
};

/**
 * One step of a flow, seen from the map: its trail, title, tags and code, read-only. A look,
 * not a move: it changes nothing in the tour unless a button says so.
 */
export function Peek({
  repo,
  pr,
  tour,
  flow,
  stepId,
  line,
  seen,
  keys,
  review,
  onMove,
  onMarkSeen,
  onOpenInTour,
  onClose,
}: Props): ReactNode {
  const index = flow.steps.findIndex((s) => s.id === stepId);
  const step = flow.steps[index];
  const file = step?.file;
  // A new reveal only when the place changes, not on every render.
  const reveal = useMemo(
    (): Reveal | null =>
      line === null || file === undefined
        ? null
        : { at: { path: file, side: 'new', line }, seq: ++revealSeq },
    [file, line],
  );
  if (!step) return null;

  const target = codeTarget({ kind: 'step', id: step.id, step, flow });
  const flowNo = tour.flows.findIndex((f) => f.id === flow.id) + 1;
  const from = cameFrom(flow, step);
  const changes = step.homes.length;
  const nextId = flow.steps[index + 1]?.id;
  const inFlow = (id: string) => flow.steps.some((s) => s.id === id);

  return (
    <section className="peek" aria-labelledby={`peek-title-${step.id}`}>
      <div className="peek-head">
        <p className="peek-trail" data-testid="peek-trail">
          Flow {flowNo} · step {index + 1} of {flow.steps.length}
          {from && (
            <span className="peek-from" title={from.check !== 'proven' ? from.reason : undefined}>
              {' · '}
              {CAME_FROM_LABEL[from.how].toLowerCase()} step {from.callerNo}
              {from.line !== null && <>, line {from.line}</>}
              {proofTag(from.check, from.source)}
            </span>
          )}
        </p>
        <div className="peek-title-row">
          <h3 className="peek-title" id={`peek-title-${step.id}`}>
            {step.title}
          </h3>
          <div className="peek-actions">
            <button type="button" className="link-button" onClick={() => onOpenInTour(step.id)}>
              Open in tour<span aria-hidden="true"> ↗</span>
            </button>
            {!seen && (
              <button type="button" onClick={() => onMarkSeen(step.id)}>
                Mark as seen
              </button>
            )}
            <button type="button" onClick={onClose} title={withKey('Close', 'Esc')}>
              Close
            </button>
          </div>
        </div>
        <ul className="peek-tags" aria-label="Step tags">
          {step.risk === 'read-closely' && <li className="peek-tag-risk">read closely</li>}
          <li>
            {changes === 0 ? 'no changes' : `${changes} ${changes === 1 ? 'change' : 'changes'}`}
          </li>
          {effectWords(step.sideEffects).map(({ word, labels }) => (
            <li key={word} title={labels.join('; ')}>
              {word}
            </li>
          ))}
          <li className={seen ? 'peek-tag-seen' : undefined}>{seen ? 'seen' : 'not seen yet'}</li>
        </ul>
        {step.riskReason && <p className="peek-reason">{step.riskReason}</p>}
      </div>
      <div className="peek-code">
        <CodeView
          repo={repo}
          pr={pr}
          tour={tour}
          file={target.file}
          focus={target.focus}
          homeId={step.id}
          reveal={reveal}
          // Only a call into another step of this flow goes anywhere: the peek moves there.
          onJump={(_file, _line, toStep) => {
            if (toStep && inFlow(toStep)) onMove(toStep, null);
          }}
          onOpenHome={() => {}}
          {...(nextId !== undefined && { onNextStep: () => onMove(nextId, null) })}
          review={review}
          readOnly
          keys={keys}
        />
      </div>
    </section>
  );
}
