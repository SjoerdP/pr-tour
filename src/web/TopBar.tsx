import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { PrSummary } from '../shared/api.js';
import { reviewableHomeIds, type Tour } from '../shared/tour.js';
import { inKeepOpenArea, keepsReviewOpen } from './keep-review-open.js';
import { ReviewPanel, type ReviewDraftText } from './ReviewPanel.js';
import type { ReviewState } from './useReview.js';

const EMPTY_REVIEW_TEXT: ReviewDraftText = { event: 'COMMENT', body: '' };

type Props = {
  pr: PrSummary;
  tour: Tour | null;
  isSeen: (homeId: string) => boolean;
  /** "About this PR" is shown. */
  aboutOpen: boolean;
  onAboutChange: (open: boolean) => void;
  /** The PR's review, done in the Review panel. */
  review: ReviewState;
  /** Opens a home, or a file at a line: where the Review panel's items jump to. */
  onOpenHome: (homeId: string) => void;
  onJump: (file: string, line: number) => void;
};

/**
 * One line above the tour: back to the inbox, the PR, a short status, "About this PR",
 * which shows the tour summary and check problems, and "Review", which opens the review
 * panel. A click outside a panel closes it.
 */
export function TopBar({
  pr,
  tour,
  isSeen,
  aboutOpen,
  onAboutChange,
  review,
  onOpenHome,
  onJump,
}: Props) {
  const panelId = useId();
  const reviewPanelId = useId();
  const open = tour !== null && aboutOpen;
  const panel = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Moving through the tour does not close the review panel: it lives here, not in the step.
  const [reviewChoice, setReviewOpen] = useState(false);
  const reviewOpen = tour !== null && reviewChoice;
  const reviewBox = useRef<HTMLDivElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  // The summary and event outlive the panel: closing it must not lose what was typed.
  // Kept per PR, so another PR in the same view starts empty.
  const prKey = `${pr.repo}#${pr.number}`;
  const [storedText, setStoredText] = useState<{ key: string; text: ReviewDraftText } | null>(null);
  const reviewText = storedText?.key === prKey ? storedText.text : EMPTY_REVIEW_TEXT;
  const setReviewText = (text: ReviewDraftText) => setStoredText({ key: prKey, text });

  useEffect(() => {
    if (!reviewOpen) return;
    // Clicks on navigation (outline, step bar, this bar) keep it open; others close it.
    function onMouseDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (reviewBox.current?.contains(target) || reviewButton.current?.contains(target)) return;
      if (inKeepOpenArea(target)) return;
      setReviewOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [reviewOpen]);

  /** Esc inside the panel closes it and puts focus back on the Review button. */
  function onReviewKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    // The tour's own Esc (back from a jump) must not run as well.
    event.stopPropagation();
    closeReview();
  }

  function closeReview() {
    setReviewOpen(false);
    reviewButton.current?.focus();
  }

  function toggleReview() {
    if (!reviewOpen) onAboutChange(false);
    setReviewOpen(!reviewOpen);
  }

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
  const drafts = review.drafts.length;

  return (
    <header className="topbar" {...keepsReviewOpen}>
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
      {tour && (
        <button
          type="button"
          className={drafts > 0 ? 'primary review-button' : 'review-button'}
          ref={reviewButton}
          aria-expanded={reviewOpen}
          aria-controls={reviewOpen ? reviewPanelId : undefined}
          onClick={toggleReview}
        >
          {drafts > 0 ? `Review · ${drafts}` : 'Review'}
        </button>
      )}
      {tour && reviewOpen && (
        <div
          ref={reviewBox}
          id={reviewPanelId}
          className="review-panel-box"
          onKeyDown={onReviewKeyDown}
        >
          <ReviewPanel
            review={review}
            text={reviewText}
            onTextChange={setReviewText}
            tour={tour}
            isSeen={isSeen}
            onOpenHome={onOpenHome}
            onJump={onJump}
            onClose={closeReview}
          />
        </div>
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
