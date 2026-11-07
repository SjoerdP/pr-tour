import { useState, type ReactNode } from 'react';
import type { ProblemMark } from '../shared/api.js';
import { LEVEL_LABEL, type Level, type PlacedProblem } from '../shared/problems.js';
import { useProblemsContext } from './ProblemsContext.js';
import { safeHref } from './safe-href.js';

// A possible problem in the tour: under its line in the code, or at the top of its step.
// The small parts (level chip, sources, marks) are shared with the overview list and with
// a bot's review thread.

/** The level as a coloured chip: `Likely bug`, `Risk`, `Worth a look`. */
export function LevelChip({ level }: { level: Level }) {
  return <span className={`problem-chip problem-${level}`}>{LEVEL_LABEL[level]}</span>;
}

/** Who reported the problem, one tag each. */
export function ProblemSources({ sources }: { sources: string[] }) {
  return (
    <span className="problem-sources">
      {sources.map((s) => (
        <span key={s} className="problem-source">
          {s}
        </span>
      ))}
    </span>
  );
}

/**
 * "Real problem" and "Not a problem": pressing one marks the problem, pressing it again takes
 * the mark away. `onMark` hears each new mark; `children` go after the two buttons.
 */
export function ProblemMarks({
  problemKey,
  onMark,
  children,
}: {
  problemKey: string;
  onMark?: (mark: ProblemMark | null) => void;
  children?: ReactNode;
}) {
  const { markOf, setMark } = useProblemsContext();
  const mark = markOf(problemKey);
  return (
    <span className="problem-marks">
      {(['real', 'not'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="problem-mark"
          aria-pressed={mark === m}
          onClick={() => {
            const next = mark === m ? null : m;
            setMark(problemKey, next);
            onMark?.(next);
          }}
        >
          {m === 'real' ? 'Real problem' : 'Not a problem'}
        </button>
      ))}
      {children}
    </span>
  );
}

/** What "Comment" puts in the comment box: the title, then the reason. */
export function commentText(problem: PlacedProblem): string {
  return problem.why === undefined ? problem.title : `${problem.title}\n\n${problem.why}`;
}

type Props = {
  problem: PlacedProblem;
  /** Opens the comment box on the problem's line with `text`; no "Comment" button without it. */
  onComment?: ((text: string) => void) | undefined;
  /** Show the problem only: no marks and no "Comment". */
  readOnly?: boolean;
};

/**
 * One possible problem, in its level's colour: level chip, title, reason, sources, and the
 * marks. Marked "Not a problem", it folds up to one line; a click opens it.
 */
export function ProblemCard({ problem, onComment, readOnly = false }: Props) {
  const { markOf } = useProblemsContext();
  const mark = markOf(problem.key);
  const [open, setOpen] = useState(false);
  const className = `problem-card problem-inline problem-${problem.level}${mark === 'not' ? ' problem-not' : ''}`;

  if (mark === 'not' && !open) {
    return (
      <div className={className}>
        <button
          type="button"
          className="link-button problem-unfold"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          Not a problem · {problem.title}
        </button>
      </div>
    );
  }

  // A line problem's place is the line itself; others link to where they were found (CI).
  const href =
    problem.at.kind !== 'line' && problem.url !== undefined ? safeHref(problem.url) : null;
  return (
    <div className={className}>
      <div className="problem-head">
        <LevelChip level={problem.level} />{' '}
        <span className="problem-title">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer">
              {problem.title}
            </a>
          ) : (
            problem.title
          )}
        </span>
      </div>
      {problem.why !== undefined && <p className="problem-why muted">{problem.why}</p>}
      <div className="problem-foot">
        <ProblemSources sources={problem.sources} />
        {!readOnly && (
          // Marked "Not a problem" again: it folds up again.
          <ProblemMarks problemKey={problem.key} onMark={(m) => m === 'not' && setOpen(false)}>
            {onComment && (
              <button
                type="button"
                className="problem-mark"
                onClick={() => onComment(commentText(problem))}
              >
                Comment
              </button>
            )}
          </ProblemMarks>
        )}
      </div>
    </div>
  );
}
