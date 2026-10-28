import { lastChangedStepIndex, type Flow, type Step } from '../shared/tour.js';
import { withKey } from './shortcuts.js';

type Props = {
  flow: Flow;
  step: Step;
  /** Go to the next flow; undefined when there is none. */
  onSkip: (() => void) | undefined;
};

/**
 * On the first step after a flow's last change: the changes stop here, the rest is how the
 * flow goes on. The reviewer can read on or skip to the next flow.
 */
export function FlowEndNote({ flow, step, onSkip }: Props) {
  const lastChanged = lastChangedStepIndex(flow);
  if (flow.steps.findIndex((s) => s.id === step.id) !== lastChanged + 1) return null;

  return (
    <div className="flow-end-banner" role="note">
      <span>
        {lastChanged === -1
          ? 'No changes in this flow. The steps below show how it works.'
          : 'No more changes in this flow. The steps below show how it continues.'}
      </span>{' '}
      <button
        type="button"
        onClick={onSkip}
        disabled={onSkip === undefined}
        title={withKey('Skip to next flow', ']')}
      >
        Skip to next flow
      </button>
    </div>
  );
}
