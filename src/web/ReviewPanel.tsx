import { useId, useState } from 'react';
import { isOlderDraft, type Draft, type ReviewEvent, type ReviewThread } from '../shared/review.js';
import type { Tour } from '../shared/tour.js';
import { errorText } from './errors.js';
import { homeAt, homeFile, homeTitle, unseenForReview } from './homes.js';
import { OLDER_DRAFT_NOTICE } from './Thread.js';
import type { ReviewState } from './useReview.js';

type Props = {
  review: ReviewState;
  tour: Tour;
  isSeen: (homeId: string) => boolean;
  /** Opens a home of the tour. */
  onOpenHome: (homeId: string) => void;
  /** Opens a file at a line, for places no home owns (the code view's jump). */
  onJump: (file: string, line: number) => void;
  onClose: () => void;
};

const EVENTS: Array<{ event: ReviewEvent; label: string }> = [
  { event: 'COMMENT', label: 'Comment' },
  { event: 'APPROVE', label: 'Approve' },
  { event: 'REQUEST_CHANGES', label: 'Request changes' },
];

const OWN_PR_REASON = "You can't approve your own PR on GitHub.";

/** A place in the code: what the panel shows and where a click goes. */
type Place = { path: string; side: 'new' | 'old' | null; start: number; end: number };

function threadPlace(thread: ReviewThread): Place {
  const end = thread.line ?? 1;
  return { path: thread.path, side: thread.side, start: thread.startLine ?? end, end };
}

function lines(start: number, end: number): string {
  return start === end ? `${start}` : `${start}–${end}`;
}

/** "src/a.ts:5", "src/a.ts:2–4", "src/a.ts:5 (old)", or just the path for a file-level place. */
function placeText(place: Place): string {
  if (place.side === null) return place.path;
  const old = place.side === 'old' ? ' (old)' : '';
  return `${place.path}:${lines(place.start, place.end)}${old}`;
}

/** The first line of `text`, cut to a short preview. */
function preview(text: string): string {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/**
 * The review: pending drafts and unresolved threads (each opens its place), a summary, the
 * event, and Submit. Approving with unseen items first lists them. Nothing reaches GitHub
 * before Submit.
 */
export function ReviewPanel({ review, tour, isSeen, onOpenHome, onJump, onClose }: Props) {
  const reasonId = useId();
  const groupName = useId();
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [body, setBody] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const own = review.viewerIsAuthor;
  // On their own PR the author can only comment, whatever was picked before.
  const chosen: ReviewEvent = own ? 'COMMENT' : event;
  const unseen = chosen === 'APPROVE' ? unseenForReview(tour, isSeen) : [];
  const { drafts, submitError } = review;
  const unresolved = review.threads.filter((t) => !t.resolved);
  // GitHub refuses a comment or request-changes review with nothing in it.
  const empty = chosen !== 'APPROVE' && body.trim() === '' && drafts.length === 0;

  /** Opens the home that owns the place and shows its file, else the file at the line. */
  function go(place: Place) {
    const home = homeAt(tour, place.path, place.side, place.start, place.end);
    if (home && homeFile(home) === place.path) onOpenHome(home.id);
    else onJump(place.path, place.end);
  }

  function draftPlace(draft: Draft): { text: string; place: Place | null } {
    if (draft.kind === 'comment') {
      const place = {
        path: draft.path,
        side: draft.side,
        start: draft.startLine,
        end: draft.endLine,
      };
      return { text: placeText(place), place };
    }
    const thread = review.threads.find((t) => t.id === draft.threadId);
    return thread
      ? { text: `reply in ${thread.path}`, place: threadPlace(thread) }
      : { text: 'reply', place: null };
  }

  async function remove(id: number) {
    setDeleteError(null);
    try {
      await review.remove(id);
    } catch (err) {
      setDeleteError(errorText(err));
    }
  }

  async function submit() {
    const result = await review.submit(chosen, body);
    if (result) {
      setSent(result.url);
      setBody('');
      setEvent('COMMENT');
    }
  }

  return (
    <section className="review-panel" aria-label="Review">
      <div className="review-panel-head">
        <h2>Review</h2>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </div>

      {review.state === 'loading' && <p className="muted">Loading comments…</p>}
      {review.state === 'error' && (
        <p className="error" role="alert">
          Could not load comments: {review.error}
        </p>
      )}
      {review.state === 'ready' && review.error !== undefined && (
        <p className="muted refresh-note" title={review.error}>
          Couldn't refresh comments
        </p>
      )}

      {sent !== null && (
        <p className="review-sent" role="status">
          Review sent.{' '}
          <a href={sent} target="_blank" rel="noreferrer" onClick={onClose}>
            View it on GitHub
          </a>
        </p>
      )}

      <h3 className="review-panel-title">Pending comments</h3>
      {drafts.length === 0 ? (
        <p className="muted">No pending comments.</p>
      ) : (
        <ul className="review-list" aria-label="Pending comments">
          {drafts.map((draft) => {
            const { text, place } = draftPlace(draft);
            const older = review.headSha !== null && isOlderDraft(draft, review.headSha);
            const failed = submitError?.failedDraftId === draft.id;
            return (
              <li key={draft.id} className={failed ? 'failed' : undefined}>
                <div className="review-item-head">
                  {place ? (
                    <button type="button" className="link-button" onClick={() => go(place)}>
                      {text}
                    </button>
                  ) : (
                    <span>{text}</span>
                  )}
                  {older && <span className="older-label">older version</span>}
                  {failed && <span className="failed-label">Not sent</span>}
                  <button
                    type="button"
                    className="link-button review-delete"
                    aria-label={`Delete draft on ${text}`}
                    onClick={() => void remove(draft.id)}
                  >
                    Delete
                  </button>
                </div>
                <p className="review-preview">{preview(draft.body)}</p>
                {older && <p className="older-notice">{OLDER_DRAFT_NOTICE}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {deleteError !== null && (
        <p className="error" role="alert">
          Could not delete the draft: {deleteError}
        </p>
      )}

      {unresolved.length > 0 && (
        <>
          <h3 className="review-panel-title">Unresolved threads</h3>
          <ul className="review-list" aria-label="Unresolved threads">
            {unresolved.map((thread) => {
              const place = threadPlace(thread);
              const first = thread.comments[0];
              return (
                <li key={thread.id}>
                  <button type="button" className="link-button" onClick={() => go(place)}>
                    {placeText(place)}
                  </button>
                  {first && (
                    <p className="review-preview">
                      {first.author}: {preview(first.body)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <label className="review-summary-label" htmlFor={`${groupName}-summary`}>
        Summary
      </label>
      <textarea
        id={`${groupName}-summary`}
        className="review-summary"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      <fieldset
        className="review-events"
        role="radiogroup"
        aria-label="Review event"
        aria-describedby={own ? reasonId : undefined}
      >
        {EVENTS.map(({ event: value, label }) => (
          <label key={value}>
            <input
              type="radio"
              name={groupName}
              value={value}
              checked={chosen === value}
              disabled={own && value !== 'COMMENT'}
              onChange={() => setEvent(value)}
            />
            {label}
          </label>
        ))}
        {own && (
          <p id={reasonId} className="muted">
            {OWN_PR_REASON}
          </p>
        )}
      </fieldset>

      {unseen.length > 0 && (
        <section className="approve-reminder" aria-label="Not seen yet">
          <p>
            You haven't seen {unseen.length} {unseen.length === 1 ? 'item' : 'items'}
          </p>
          <ul>
            {unseen.map((home) => (
              <li key={home.id}>
                {homeTitle(home)}{' '}
                <button type="button" className="link-button" onClick={() => onOpenHome(home.id)}>
                  Go to it
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {submitError && (
        <p className="error" role="alert">
          {submitError.message}
        </p>
      )}
      <div className="review-actions">
        <button
          type="button"
          className="primary"
          disabled={review.submitting || empty}
          onClick={() => void submit()}
        >
          {unseen.length > 0 ? 'Approve anyway' : 'Submit review'}
        </button>
        {empty && <span className="muted">Write a summary or add a comment first.</span>}
      </div>
    </section>
  );
}
