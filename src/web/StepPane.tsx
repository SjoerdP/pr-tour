import { useId, useState, type ReactNode } from 'react';
import type { Range, SideEffect, Tour } from '../shared/tour.js';
import type { Focus as CodeFocus } from './code-lines.js';
import { CodeView } from './CodeView.js';
import { FlowEndNote } from './FlowEndNote.js';
import { homeTitle, type Home } from './homes.js';
import { withKey } from './shortcuts.js';

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

/** Where the home sits in the tour: "Flow 1 · step 4 of 14", "Foundation · migration", ... */
function trail(tour: Tour, home: Home): string {
  switch (home.kind) {
    case 'foundation':
      return `Foundation · ${home.foundation.kind}`;
    case 'step': {
      const flowNo = tour.flows.findIndex((f) => f.id === home.flow.id) + 1;
      const stepNo = home.flow.steps.findIndex((s) => s.id === home.id) + 1;
      return `Flow ${flowNo} · step ${stepNo} of ${home.flow.steps.length}`;
    }
    case 'other':
      return `Other changes · ${home.group.title}`;
  }
}

/** The trail's tooltip: the names the short trail leaves out. */
function trailTitle(home: Home): string | undefined {
  return home.kind === 'step' ? `${home.flow.title} · ${home.flow.entry.label}` : undefined;
}

const EFFECT_FACTS: Record<SideEffect['kind'], string> = {
  'db-write': 'writes to DB',
  event: 'emits an event',
  'external-call': 'calls an external service',
};

type Fact = { text: string; tone?: 'risk' | 'warn' };

/** The one line of facts under the title. */
function facts(home: Home): Fact[] {
  const out: Fact[] = [];
  switch (home.kind) {
    case 'step': {
      const { step } = home;
      if (step.homes.length === 0) out.push({ text: 'Unchanged' }, { text: 'context' });
      if (step.risk === 'read-closely') out.push({ text: 'Read closely', tone: 'risk' });
      const kinds = [...new Set(step.sideEffects.map((e) => e.kind))];
      for (const kind of kinds) {
        const n = step.sideEffects.filter((e) => e.kind === kind).length;
        out.push({ text: n > 1 ? `${EFFECT_FACTS[kind]} ×${n}` : EFFECT_FACTS[kind] });
      }
      if (step.tests.length > 0) {
        out.push({ text: `${step.tests.length} ${step.tests.length === 1 ? 'test' : 'tests'}` });
      } else if (step.changed) {
        out.push({ text: 'no tests cover this step', tone: 'warn' });
      }
      break;
    }
    case 'foundation':
      if (home.foundation.risk === 'read-closely') out.push({ text: 'Read closely', tone: 'risk' });
      if (home.foundation.deployCompat?.ok === false) {
        out.push({ text: 'not deploy compatible', tone: 'warn' });
      }
      break;
    case 'other':
      if (home.group.kind === 'generated') out.push({ text: 'Generated' }, { text: 'skim' });
      break;
  }
  return out;
}

/** Moves through the tour, the same as the keys. An undefined move has nowhere to go. */
export type PaneNav = {
  previousStep: (() => void) | undefined;
  nextStep: () => void;
  previousFlow: (() => void) | undefined;
  nextFlow: (() => void) | undefined;
};

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
  nav: PaneNav;
};

/** The current home: its header and notes, then its code, then the step buttons. */
export function StepPane({ repo, pr, tour, home, jump, onJump, onBack, onOpenHome, nav }: Props) {
  const why =
    home.kind === 'foundation'
      ? home.foundation.why
      : home.kind === 'step'
        ? home.step.why
        : home.item.why;
  const target = jump
    ? { file: jump.file, focus: { start: jump.line, end: jump.line } }
    : codeTarget(home);
  const homeFacts = facts(home);

  return (
    <article className="step-pane" aria-labelledby={`step-title-${home.id}`}>
      <div className="step-notes">
        <div className="step-head">
          <p className="step-trail" data-testid="step-trail" title={trailTitle(home)}>
            {trail(tour, home)}
          </p>
          <h2 className="step-title" id={`step-title-${home.id}`}>
            {homeTitle(home)}
          </h2>
          {homeFacts.length > 0 && (
            <ul className="step-facts" aria-label="Step facts">
              {homeFacts.map((fact, i) => (
                <li key={i} className={fact.tone ? `fact-${fact.tone}` : undefined}>
                  {fact.tone === 'risk' && <span className="rc-dot" aria-hidden="true" />}
                  {fact.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        {why !== undefined && (
          <section className="why">
            <h3 className="why-label">
              Why · {tour.source === 'author' ? 'by the author' : 'inferred by Claude'}
            </h3>
            <p>{why}</p>
          </section>
        )}
        {home.kind === 'other' && <p className="why group-note">{home.group.summary}</p>}

        {/* New home, fresh extras: they start shut (except a deploy note that is not ok). */}
        <Extras key={home.id} home={home} />
      </div>

      {home.kind === 'step' && (
        <FlowEndNote flow={home.flow} step={home.step} onSkip={nav.nextFlow} />
      )}
      {jump && (
        <p className="jump-bar">
          Showing <code>{jump.file}</code> line {jump.line}.{' '}
          <button
            type="button"
            className="link-button"
            onClick={onBack}
            title={withKey('Back to this step', 'Esc')}
          >
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
      <div className="step-nav">
        <button
          type="button"
          onClick={nav.previousStep}
          disabled={nav.previousStep === undefined}
          title={withKey('Previous step', 'k')}
        >
          <span aria-hidden="true">← </span>Previous step
        </button>
        <p className="key-hints">j / k steps · [ ] flows · n / p changes · f whole file</p>
        <button
          type="button"
          className="primary"
          onClick={nav.nextStep}
          title={withKey('Next step', 'j')}
        >
          Next step<span aria-hidden="true"> →</span>
        </button>
      </div>
    </article>
  );
}

type Extra = { id: string; label: string; content: ReactNode; startOpen?: boolean };

function extrasOf(home: Home): Extra[] {
  if (home.kind === 'step') {
    const { step } = home;
    const out: Extra[] = [];
    if (step.riskReason) {
      out.push({ id: 'risk', label: 'Why read closely', content: <p>{step.riskReason}</p> });
    }
    if (step.sideEffects.length > 0) {
      out.push({
        id: 'effects',
        label: `Side effects (${step.sideEffects.length})`,
        content: (
          <ul>
            {step.sideEffects.map((effect, i) => (
              <li key={i}>
                <span className="fx">{effect.kind}</span> {effect.label}
              </li>
            ))}
          </ul>
        ),
      });
    }
    if (step.tests.length > 0) {
      out.push({
        id: 'tests',
        label: `Tests (${step.tests.length})`,
        content: (
          <ul>
            {step.tests.map((test, i) => (
              <li key={i}>
                <code>{test.file}</code> — {test.name}
              </li>
            ))}
          </ul>
        ),
      });
    }
    return out;
  }
  if (home.kind === 'foundation') {
    const { schemaAfter, deployCompat } = home.foundation;
    const out: Extra[] = [];
    if (schemaAfter !== undefined) {
      out.push({
        id: 'schema',
        label: 'Schema after',
        content: <pre className="schema">{schemaAfter}</pre>,
      });
    }
    if (deployCompat) {
      out.push({
        id: 'deploy',
        label: 'Deploy compatibility',
        startOpen: !deployCompat.ok,
        content: (
          <p className={deployCompat.ok ? undefined : 'warn'}>
            {deployCompat.ok ? 'Compatible: ' : 'Not compatible: '}
            {deployCompat.note}
          </p>
        ),
      });
    }
    return out;
  }
  return [];
}

/** Small links under the note that open more detail in place. */
function Extras({ home }: { home: Home }) {
  const baseId = useId();
  const extras = extrasOf(home);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(extras.filter((e) => e.startOpen).map((e) => e.id)),
  );
  if (extras.length === 0) return null;

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="extras">
      <div className="extras-links">
        {extras.map((extra) => (
          <button
            key={extra.id}
            type="button"
            className="link-button extra-toggle"
            aria-expanded={open.has(extra.id)}
            aria-controls={`${baseId}-${extra.id}`}
            onClick={() => toggle(extra.id)}
          >
            {extra.label}
          </button>
        ))}
      </div>
      {extras
        .filter((extra) => open.has(extra.id))
        .map((extra) => (
          <section
            key={extra.id}
            id={`${baseId}-${extra.id}`}
            className="extra"
            aria-label={extra.label}
          >
            {extra.content}
          </section>
        ))}
    </div>
  );
}
