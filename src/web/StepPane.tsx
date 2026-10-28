import type { Foundation, Range, Step, Tour } from '../shared/tour.js';
import type { Focus as CodeFocus } from './code-lines.js';
import { CodeView } from './CodeView.js';
import { homeTitle, type Home } from './homes.js';

type Focus = CodeFocus | null;

/**
 * What the code view opens on: the first head-side range of `file` in `homes`, else the
 * first base-side one (a home of only deleted lines).
 */
function firstRange(homes: Range[], file: string): Focus {
  for (const side of ['new', 'old'] as const) {
    for (const r of homes) {
      if ('side' in r && r.side === side && r.file === file) {
        return { start: r.start, end: r.end, side };
      }
    }
  }
  return null;
}

function codeTarget(home: Home): { file: string; focus: Focus } {
  switch (home.kind) {
    case 'step':
      return {
        file: home.step.file,
        focus: { start: home.step.startLine, end: home.step.endLine },
      };
    case 'foundation':
      return {
        file: home.foundation.file,
        focus: firstRange(home.foundation.homes, home.foundation.file),
      };
    case 'other':
      return { file: home.item.file, focus: firstRange(home.item.homes, home.item.file) };
  }
}

function contextLine(home: Home): string {
  switch (home.kind) {
    case 'foundation':
      return `Foundation · ${home.foundation.kind}`;
    case 'step':
      return `${home.flow.title} · ${home.flow.entry.label}`;
    case 'other':
      return `Other changes · ${home.group.title}`;
  }
}

type Props = {
  repo: string;
  pr: number;
  tour: Tour;
  home: Home;
  /** A traced call the user followed: shown instead of the home's own code. */
  jump: { file: string; line: number } | null;
  onJump: (file: string, line: number) => void;
  onBack: () => void;
  onOpenHome: (homeId: string) => void;
};

/** The current home: its notes, then its code. */
export function StepPane({ repo, pr, tour, home, jump, onJump, onBack, onOpenHome }: Props) {
  const why =
    home.kind === 'foundation'
      ? home.foundation.why
      : home.kind === 'step'
        ? home.step.why
        : home.item.why;
  const risk =
    home.kind === 'foundation'
      ? home.foundation.risk
      : home.kind === 'step'
        ? home.step.risk
        : null;
  const target = jump
    ? { file: jump.file, focus: { start: jump.line, end: jump.line } }
    : codeTarget(home);

  return (
    <article className="step-pane" aria-labelledby={`step-title-${home.id}`}>
      <p className="muted step-context">{contextLine(home)}</p>
      <h2 className="step-title" id={`step-title-${home.id}`}>
        {homeTitle(home)}
        {risk === 'read-closely' && <span className="tag tag-warn">read closely</span>}
      </h2>

      {why !== undefined && (
        <section className="note">
          <h3>Why · {tour.source === 'author' ? 'by the author' : 'inferred by Claude'}</h3>
          <p>{why}</p>
        </section>
      )}
      {home.kind === 'other' && <p className="muted">{home.group.summary}</p>}

      {home.kind === 'step' && <StepDetails step={home.step} />}
      {home.kind === 'foundation' && <FoundationDetails foundation={home.foundation} />}

      {jump && (
        <p className="jump-bar">
          Showing <code>{jump.file}</code> line {jump.line}.{' '}
          <button type="button" className="link-button" onClick={onBack}>
            Back to this step
          </button>{' '}
          <span className="muted">(Esc)</span>
        </p>
      )}
      <CodeView
        repo={repo}
        pr={pr}
        tour={tour}
        file={target.file}
        focus={target.focus}
        homeId={home.id}
        plain={!jump && home.kind === 'other' && home.group.kind === 'generated'}
        onJump={onJump}
        onOpenHome={onOpenHome}
      />
    </article>
  );
}

function StepDetails({ step }: { step: Step }) {
  return (
    <>
      {step.riskReason && (
        <section className="note">
          <h3>Risk</h3>
          <p>{step.riskReason}</p>
        </section>
      )}
      {step.sideEffects.length > 0 && (
        <section className="note">
          <h3>Side effects</h3>
          <ul>
            {step.sideEffects.map((effect, i) => (
              <li key={i}>
                <span className="tag tag-effect">{effect.kind}</span> {effect.label}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="note">
        <h3>Tests</h3>
        {step.tests.length > 0 ? (
          <ul>
            {step.tests.map((test, i) => (
              <li key={i}>
                <code>{test.file}</code> — {test.name}
              </li>
            ))}
          </ul>
        ) : step.changed ? (
          <p className="warn">no tests cover this step</p>
        ) : (
          <p className="muted">None listed.</p>
        )}
      </section>
    </>
  );
}

function FoundationDetails({ foundation }: { foundation: Foundation }) {
  return (
    <>
      {foundation.schemaAfter !== undefined && (
        <section className="note">
          <h3>Schema after</h3>
          <pre className="schema">{foundation.schemaAfter}</pre>
        </section>
      )}
      {foundation.deployCompat && (
        <section className="note">
          <h3>Deploy compatibility</h3>
          <p className={foundation.deployCompat.ok ? undefined : 'warn'}>
            {foundation.deployCompat.ok ? 'Compatible: ' : 'Not compatible: '}
            {foundation.deployCompat.note}
          </p>
        </section>
      )}
    </>
  );
}
