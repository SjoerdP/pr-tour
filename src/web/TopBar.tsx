import { useEffect, useId, useRef } from 'react';
import type { PrSummary } from '../shared/api.js';
import { reviewableHomeIds, type Tour } from '../shared/tour.js';

type Props = {
  pr: PrSummary;
  tour: Tour | null;
  isSeen: (homeId: string) => boolean;
  /** "About this PR" is shown. */
  aboutOpen: boolean;
  onAboutChange: (open: boolean) => void;
};

/**
 * One line above the tour: back to the inbox, the PR, a short status, and "About this PR",
 * which shows the tour summary and check problems. A click outside the panel closes it.
 */
export function TopBar({ pr, tour, isSeen, aboutOpen, onAboutChange }: Props) {
  const panelId = useId();
  const open = tour !== null && aboutOpen;
  const panel = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (panel.current?.contains(target) || button.current?.contains(target)) return;
      onAboutChange(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, onAboutChange]);

  const problems = tour?.check.problems ?? [];

  return (
    <header className="topbar">
      <a className="button-link" href="/">
        ← Inbox
      </a>
      <h1 className="topbar-title" title={`${pr.repo}#${pr.number} ${pr.title}`}>
        <span className="pr-number">
          {pr.repo}#{pr.number}
        </span>{' '}
        <a href={pr.url}>{pr.title}</a>
      </h1>
      {tour && <p className="topbar-meta">{status(tour, isSeen)}</p>}
      {tour && (
        <button
          type="button"
          className="about-button"
          ref={button}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => onAboutChange(!open)}
        >
          About this PR
          {problems.length > 0 && (
            <>
              <span className="alert-dot" aria-hidden="true" />
              <span className="sr-only"> ({problemsText(problems.length)})</span>
            </>
          )}
        </button>
      )}
      {tour && open && (
        <section ref={panel} id={panelId} className="about-panel" aria-label="About this PR">
          <p className="about-summary">{tour.summary}</p>
          {problems.length > 0 && (
            <div className="check-problems">
              <h2>{problemsText(problems.length)}</h2>
              <ul>
                {problems.map((problem, i) => (
                  <li key={i}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" className="link-button" onClick={() => onAboutChange(false)}>
            Close
          </button>
        </section>
      )}
    </header>
  );
}

function problemsText(n: number): string {
  return `${n} ${n === 1 ? 'check problem' : 'check problems'}`;
}

function status(tour: Tour, isSeen: (homeId: string) => boolean): string {
  const flows = tour.flows.length;
  const ids = reviewableHomeIds(tour);
  const seen = ids.filter(isSeen).length;
  const source = tour.source === 'author' ? 'notes by the author' : 'notes inferred by Claude';
  return `${flows} ${flows === 1 ? 'flow' : 'flows'} · ${seen} / ${ids.length} seen · ${source}`;
}
