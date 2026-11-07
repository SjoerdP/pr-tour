import { useId, useMemo, type ReactNode } from 'react';
import { LEVEL_ORDER, type Level, type PlacedProblem } from '../shared/problems.js';
import type { Tour } from '../shared/tour.js';
import { homesInOrder, type Home } from './homes.js';
import { LevelChip, ProblemMarks, ProblemSources } from './ProblemCard.js';
import { useProblemsContext } from './ProblemsContext.js';
import { safeHref } from './safe-href.js';

/** A line to show when a home opens. */
export type VisitAt = { file: string; line: number };

type Props = {
  tour: Tour;
  /** Opens a home as a visit, at the line when there is one. */
  onVisit: (homeId: string, at?: VisitAt) => void;
  /** Shows a file of the PR at a line: for a problem on a line no home holds. */
  onShowLine?: ((file: string, line: number) => void) | undefined;
};

/** How the count line names each level: one and many. */
const LEVEL_COUNT: Record<Level, [string, string]> = {
  bug: ['likely bug', 'likely bugs'],
  risk: ['risk', 'risks'],
  look: ['worth a look', 'worth a look'],
};

/** `1 likely bug · 2 risks · 1 worth a look`: only the levels there are. */
function countLine(problems: PlacedProblem[]): string {
  return LEVEL_ORDER.map((level) => {
    const n = problems.filter((p) => p.level === level).length;
    const [one, many] = LEVEL_COUNT[level];
    return n === 0 ? null : `${n} ${n === 1 ? one : many}`;
  })
    .filter(Boolean)
    .join(' · ');
}

/** Where a home sits: `Flow 1 · step 3 · Charge the fee`, `Foundation · migration · …`. */
function homeLabel(tour: Tour, home: Home): string {
  switch (home.kind) {
    case 'foundation':
      return `Foundation · ${home.foundation.kind} · ${home.foundation.title}`;
    case 'step': {
      const flowNo = tour.flows.findIndex((f) => f.id === home.flow.id) + 1;
      const stepNo = home.flow.steps.findIndex((s) => s.id === home.id) + 1;
      return `Flow ${flowNo} · step ${stepNo} · ${home.step.title}`;
    }
    case 'other':
      return `Other changes · ${home.group.title} · ${home.item.title}`;
  }
}

/** The line a problem is about on the head side, if any: where its home opens. */
function headLine(p: PlacedProblem): VisitAt | undefined {
  return p.at.kind === 'line' && p.at.side === 'new'
    ? { file: p.at.file, line: p.at.line }
    : undefined;
}

/** A problem in no home, about a line or a file of the PR. */
function isElsewhere(p: PlacedProblem): boolean {
  return p.homeId === null && (p.at.kind === 'line' || p.at.kind === 'file');
}

/**
 * The overview's list of possible problems, worst first. A problem marked "Not a problem"
 * stays, dimmed, at the end of its level.
 */
export function PossibleProblems({ tour, onVisit, onShowLine }: Props): ReactNode {
  const { problems, markOf, loading, pending, outdated, note } = useProblemsContext();
  const head = useId();
  const elsewhereHead = useId();
  const homes = useMemo(() => new Map(homesInOrder(tour).map((h) => [h.id, h])), [tour]);

  // Within each level, the ones marked "Not a problem" go last (sort is stable).
  const rank = (p: PlacedProblem) =>
    LEVEL_ORDER.indexOf(p.level) * 2 + (markOf(p.key) === 'not' ? 1 : 0);
  const ordered = [...problems].sort((a, b) => rank(a) - rank(b));
  const placed = ordered.filter((p) => !isElsewhere(p));
  const elsewhere = ordered.filter(isElsewhere);

  const notes = [
    loading && 'Reading CI results…',
    pending && 'CI is still running; more may come.',
    outdated && 'CI results of newer commits are not shown until the tour is rebuilt.',
    note,
  ].filter((n): n is string => typeof n === 'string');

  function where(p: PlacedProblem): ReactNode {
    const at = headLine(p);
    // A deleted line: its home opens at its start, so the label names no line.
    const lineText = p.at.kind === 'line' && p.at.side === 'new' ? `, line ${p.at.line}` : '';
    const home = p.homeId === null ? undefined : homes.get(p.homeId);
    if (home) {
      return (
        <button
          type="button"
          className="link-button problem-where"
          onClick={() => (at ? onVisit(home.id, at) : onVisit(home.id))}
        >
          {homeLabel(tour, home)}
          {lineText}
        </button>
      );
    }
    if (at && onShowLine) {
      return (
        <button
          type="button"
          className="link-button problem-where"
          onClick={() => onShowLine(at.file, at.line)}
        >
          {at.file}
          {lineText}
        </button>
      );
    }
    if (p.at.kind === 'line' || p.at.kind === 'file') {
      return (
        <span className="problem-where">
          {p.at.file}
          {lineText}
        </span>
      );
    }
    return null;
  }

  function card(p: PlacedProblem): ReactNode {
    const mark = markOf(p.key);
    const href = p.at.kind === 'pr' && p.url !== undefined ? safeHref(p.url) : null;
    const place = where(p);
    return (
      <li
        key={p.key}
        className={`problem-card problem-${p.level}${mark === 'not' ? ' problem-not' : ''}`}
      >
        <div className="problem-head">
          <LevelChip level={p.level} />{' '}
          <span className="problem-title">
            {href ? (
              <a href={href} target="_blank" rel="noreferrer">
                {p.title}
              </a>
            ) : (
              p.title
            )}
          </span>
        </div>
        {p.why !== undefined && <p className="problem-why muted">{p.why}</p>}
        <div className="problem-foot">
          {place}
          <ProblemSources sources={p.sources} />
          <ProblemMarks problemKey={p.key} />
        </div>
      </li>
    );
  }

  const shown = problems.length > 0;
  return (
    <section className="overview-problems" aria-labelledby={head}>
      <h3 id={head}>{shown ? `Possible problems (${problems.length})` : 'Possible problems'}</h3>
      {shown && <p className="problem-counts">{countLine(problems)}</p>}
      {!shown && !loading && (
        <>
          <p>No possible problems found.</p>
          {/* CI could not be read: only the review bots were. */}
          <p className="muted">
            {note === null ? 'Read: CI checks and review bots.' : 'Read: review bots.'}
          </p>
        </>
      )}
      {notes.map((n) => (
        <p key={n} className="muted problem-note">
          {n}
        </p>
      ))}
      {placed.length > 0 && <ul className="problem-list">{placed.map(card)}</ul>}
      {elsewhere.length > 0 && (
        <section className="problem-elsewhere" aria-labelledby={elsewhereHead}>
          <h4 id={elsewhereHead}>Elsewhere in this PR</h4>
          <ul className="problem-list">{elsewhere.map(card)}</ul>
        </section>
      )}
    </section>
  );
}
