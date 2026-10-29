import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Flow, Mark, Range, SideEffect, Step, Tour } from '../shared/tour.js';
import type { Focus as CodeFocus, Reveal } from './code-lines.js';
import { CodeView } from './CodeView.js';
import { FlowEndNote } from './FlowEndNote.js';
import { cameFrom, homeTouches, homeTitle, type CameFrom, type Home } from './homes.js';
import { keepsReviewOpen } from './keep-review-open.js';
import { withKey } from './shortcuts.js';
import type { ReviewState } from './useReview.js';

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
    case 'step': {
      // The function the code check pinned the step to, else the step's own lines.
      const { anchor, startLine, endLine } = home.step;
      return {
        file: home.step.file,
        focus: { start: anchor?.startLine ?? startLine, end: anchor?.endLine ?? endLine },
      };
    }
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

type Fact = {
  text: string;
  tone?: 'risk' | 'warn';
  /** A line of the step's code the fact shows when clicked. */
  show?: { file: string; line: number };
};

/** The db-write mark the "writes to DB" fact shows: one both sides agree on, else the code's, else Claude's. */
function dbWriteMark(step: Step): Mark | undefined {
  const marks = (step.marks ?? []).filter((m) => m.kind === 'db-write');
  return (
    marks.find((m) => m.source === 'both') ??
    marks.find((m) => m.source === 'code') ??
    marks.find((m) => m.source === 'claude')
  );
}

/** The one line of facts under the title. */
function facts(home: Home): Fact[] {
  const out: Fact[] = [];
  switch (home.kind) {
    case 'step': {
      const { step } = home;
      // "Changed" means the step owns changed lines, the same test as the outline's dots.
      const changed = step.homes.length > 0;
      if (!changed) out.push({ text: 'Unchanged' }, { text: 'context' });
      if (step.risk === 'read-closely') out.push({ text: 'Read closely', tone: 'risk' });
      const kinds = [...new Set(step.sideEffects.map((e) => e.kind))];
      for (const kind of kinds) {
        const n = step.sideEffects.filter((e) => e.kind === kind).length;
        const text = n > 1 ? `${EFFECT_FACTS[kind]} ×${n}` : EFFECT_FACTS[kind];
        const mark = kind === 'db-write' ? dbWriteMark(step) : undefined;
        out.push(mark ? { text, show: { file: step.file, line: mark.line } } : { text });
      }
      if (step.tests.length > 0) {
        out.push({ text: `${step.tests.length} ${step.tests.length === 1 ? 'test' : 'tests'}` });
      } else if (changed) {
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

/** "N comments" (threads on the home's lines) and "N pending" (drafts there), when non-zero. */
function reviewFacts(home: Home, review: ReviewState): Fact[] {
  const touching = review.threads.filter((t) =>
    // A thread without a line is file-level: only a whole-file home owns it.
    t.line === null
      ? homeTouches(home, t.path, null, 1, 1)
      : homeTouches(home, t.path, t.side, t.startLine ?? t.line, t.line),
  );
  const ids = new Set(touching.map((t) => t.id));
  const pending = review.drafts.filter((d) =>
    d.kind === 'reply'
      ? ids.has(d.threadId)
      : homeTouches(home, d.path, d.side, d.startLine, d.endLine),
  ).length;
  const out: Fact[] = [];
  const n = touching.length;
  if (n > 0) out.push({ text: `${n} ${n === 1 ? 'comment' : 'comments'}` });
  if (pending > 0) out.push({ text: `${pending} pending` });
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
  /** A place to bring into view in the code, after a jump from the review panel. */
  reveal: Reveal | null;
  onJump: (file: string, line: number, toStep?: string | null) => void;
  /** Shows a line of code from this step, with a way back: a look, not a move. */
  onShowLine: (file: string, line: number) => void;
  /** Scrolls the step's own code to a line and flashes it. */
  onRevealLine: (file: string, line: number) => void;
  onBack: () => void;
  onOpenHome: (homeId: string) => void;
  nav: PaneNav;
  /** The PR's review, shown and added to in the code view. */
  review: ReviewState;
};

/** The current home: its header and notes, then its code, then the step buttons. */
export function StepPane({
  repo,
  pr,
  tour,
  home,
  jump,
  reveal,
  onJump,
  onShowLine,
  onRevealLine,
  onBack,
  onOpenHome,
  nav,
  review,
}: Props) {
  const why =
    home.kind === 'foundation'
      ? home.foundation.why
      : home.kind === 'step'
        ? home.step.why
        : home.item.why;
  const target = jump
    ? { file: jump.file, focus: { start: jump.line, end: jump.line } }
    : codeTarget(home);
  const homeFacts = [...facts(home), ...reviewFacts(home, review)];

  return (
    <article className="step-pane" aria-labelledby={`step-title-${home.id}`}>
      <div className="step-notes">
        <div className="step-head">
          <div className="step-trail-row">
            <p className="step-trail" data-testid="step-trail" title={trailTitle(home)}>
              {trail(tour, home)}
            </p>
            {/* New home, shut again. */}
            {home.kind === 'step' && <AboutFlow key={home.id} flow={home.flow} />}
          </div>
          <h2 className="step-title" id={`step-title-${home.id}`}>
            {homeTitle(home)}
          </h2>
          {homeFacts.length > 0 && (
            <ul className="step-facts" aria-label="Step facts">
              {homeFacts.map((fact, i) => (
                <li key={i} className={fact.tone ? `fact-${fact.tone}` : undefined}>
                  {fact.tone === 'risk' && <span className="rc-dot" aria-hidden="true" />}
                  {fact.show ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onRevealLine(fact.show!.file, fact.show!.line)}
                      title={`Show line ${fact.show.line}`}
                    >
                      {fact.text}
                    </button>
                  ) : (
                    fact.text
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {home.kind === 'step' && (
          <CameFromLine flow={home.flow} step={home.step} onShowLine={onShowLine} />
        )}
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
        reveal={reveal}
        plain={!jump && home.kind === 'other' && home.group.kind === 'generated'}
        onJump={onJump}
        onOpenHome={onOpenHome}
        review={review}
      />
      {home.kind === 'step' && <NextFrom flow={home.flow} step={home.step} />}
      <div className="step-nav" {...keepsReviewOpen}>
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

const CAME_FROM_VERB: Record<CameFrom['how'], string> = {
  call: 'Called from',
  service: 'Request from',
  event: 'Event from',
};

/**
 * How the flow gets to this step: "Called from Handle the request (step 1), line 14. Step 2
 * returned first." The line shows the call. Left out for a flow's first step, and for tours
 * from before steps said where they are called from. A link the code check did not find says
 * so; one only the code found says that.
 */
function CameFromLine({
  flow,
  step,
  onShowLine,
}: {
  flow: Flow;
  step: Step;
  onShowLine: (file: string, line: number) => void;
}) {
  const from = cameFrom(flow, step);
  if (!from) return null;
  const { caller, callerNo, line, how, via, returned, check, source, others, claimedNo, reason } =
    from;
  if (check === 'not-found') {
    return (
      <p className="came-from came-from-warn" data-testid="came-from">
        The tour says <strong>{caller.title}</strong> (step {callerNo}) calls this, but the code
        does not show it.
      </p>
    );
  }
  return (
    <>
      <p
        className="came-from"
        data-testid="came-from"
        title={check !== 'proven' ? reason : undefined}
      >
        {CAME_FROM_VERB[how]} <strong>{caller.title}</strong> (step {callerNo})
        {line !== null && (
          <>
            ,{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => onShowLine(caller.file, line)}
              title={`Show line ${line} of ${caller.file}`}
            >
              line {line}
            </button>
          </>
        )}
        {via !== undefined && <>, through {via}</>}
        {source === 'code' && check === 'proven' && <>, found in the code</>}.
        {returned && (
          <span className="muted">
            {' '}
            {returned[0] === returned[1]
              ? `Step ${returned[0]} returned first.`
              : `Steps ${returned[0]} to ${returned[1]} returned first.`}
          </span>
        )}
        {others.length > 0 && (
          <> Also called from {others.map((o) => `step ${o.callerNo}`).join(', ')}.</>
        )}
      </p>
      {claimedNo !== undefined && (
        <p className="came-from came-from-warn" data-testid="came-conflict">
          The tour says step {claimedNo} calls this. The code says step {callerNo} does.
        </p>
      )}
    </>
  );
}

/**
 * Above the step buttons, when the next step of the flow is not called from this one: where
 * it is called from, so the jump back up the flow does not come as a surprise.
 */
function NextFrom({ flow, step }: { flow: Flow; step: Step }) {
  const next = flow.steps[flow.steps.indexOf(step) + 1];
  const from = next && cameFrom(flow, next);
  if (!from || from.caller === step || from.others.some((o) => o.caller === step)) return null;
  return (
    <p className="next-from" data-testid="next-from">
      Next step is called from <strong>{from.caller.title}</strong> (step {from.callerNo}), not from
      this step.
    </p>
  );
}

/**
 * "About this flow": a reminder of what the flow does and why it is in the tour, in a small
 * popover. Shut until clicked; a click outside or Esc shuts it. Left out for a flow without
 * a why.
 */
function AboutFlow({ flow }: { flow: Flow }) {
  const panelId = useId();
  // Where the popover sits, under the button; null while shut. Fixed, as the notes scroll
  // and would cut it off; so a scroll or resize shuts it rather than leave it behind.
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const open = place !== null;
  const panel = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (panel.current?.contains(target) || button.current?.contains(target)) return;
      setPlace(null);
    }
    function onMove(event: Event) {
      // A resize, or a scroll of the window itself, has no node as its target.
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      setPlace(null);
    }
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  if (flow.why === undefined) return null;

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !open) return;
    // The tour's own Esc (back from a jump) must not run as well.
    event.stopPropagation();
    setPlace(null);
    button.current?.focus();
  }

  function toggle() {
    const rect = button.current?.getBoundingClientRect();
    setPlace(open || !rect ? null : { top: rect.bottom + 4, left: rect.left });
  }

  return (
    // Esc on the button or in the popover shuts it.
    <div className="about-flow" onKeyDown={onKeyDown}>
      <button
        type="button"
        className="link-button about-flow-button"
        ref={button}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
      >
        About this flow
      </button>
      {place && (
        <section
          ref={panel}
          id={panelId}
          className="about-flow-panel"
          style={place}
          aria-label="About this flow"
        >
          <h3>{flow.title}</h3>
          <p className="about-flow-entry">
            <code>{flow.entry.label}</code>
          </p>
          <p>{flow.why}</p>
        </section>
      )}
    </div>
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
            aria-controls={open.has(extra.id) ? `${baseId}-${extra.id}` : undefined}
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
