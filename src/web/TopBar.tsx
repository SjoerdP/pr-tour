import { useEffect, useId, useState } from 'react';
import type { PrSummary } from '../shared/api.js';
import { reviewableHomeIds, type Tour } from '../shared/tour.js';

type Props = {
  pr: PrSummary;
  tour: Tour | null;
  isSeen: (homeId: string) => boolean;
};

function storageKey(pr: PrSummary): string {
  return `pr-tour:about-seen:${pr.repo}#${pr.number}`;
}

/** True when "About this PR" was shown for this PR before (in this browser). */
function aboutShownBefore(pr: PrSummary): boolean {
  try {
    return localStorage.getItem(storageKey(pr)) !== null;
  } catch {
    // Storage blocked (private window, site data off): treat every visit as the first.
    return false;
  }
}

function rememberAboutShown(pr: PrSummary): void {
  try {
    localStorage.setItem(storageKey(pr), '1');
  } catch {
    // Storage blocked: nothing to remember it in; the panel opens again next time.
  }
}

/**
 * One line above the tour: back to the inbox, the PR, a short status, and "About this PR",
 * which shows the tour summary and check problems. It is open on the first visit to a tour.
 */
export function TopBar({ pr, tour, isSeen }: Props) {
  const panelId = useId();
  const [firstVisit] = useState(() => !aboutShownBefore(pr));
  // `null` until the user toggles; until then the panel is open on the first visit only.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = tour !== null && (choice ?? firstVisit);

  const hasTour = tour !== null;
  useEffect(() => {
    // Only a visit that showed a tour counts: a first build should still end with the summary.
    if (hasTour) rememberAboutShown(pr);
  }, [hasTour, pr]);

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
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setChoice(!open)}
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
        <section id={panelId} className="about-panel" aria-label="About this PR">
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
          <button type="button" className="link-button" onClick={() => setChoice(false)}>
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
