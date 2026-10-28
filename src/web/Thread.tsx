import { useState, type ReactNode } from 'react';
import type { Draft, DraftReply, ReviewThread, ThreadComment } from '../shared/review.js';
import { Composer } from './Composer.js';
import { errorText } from './errors.js';

type Props = {
  thread: ReviewThread;
  /** Drafts to look in; only this thread's reply drafts are shown. */
  drafts: Draft[];
  /**
   * The viewer wrote the PR. GitHub still lets the author reply and resolve, so nothing
   * changes here; the prop is part of the interface for the views around threads.
   */
  viewerIsAuthor: boolean;
  onReply: (body: string) => Promise<unknown> | void;
  onEditDraft: (id: number, body: string) => Promise<unknown> | void;
  onDeleteDraft: (id: number) => Promise<unknown> | void;
  onResolve: (resolved: boolean) => Promise<unknown> | void;
  /** The time relative times count from; tests pass a fixed one. */
  now?: Date;
};

/**
 * One review thread from GitHub: its comments (bodies as plain text), its pending reply
 * drafts, and Reply / Resolve. A resolved thread starts collapsed to one line.
 */
export function Thread({
  thread,
  drafts,
  onReply,
  onEditDraft,
  onDeleteDraft,
  onResolve,
  now,
}: Props) {
  const [expanded, setExpanded] = useState(!thread.resolved);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replies = drafts.filter(
    (d): d is DraftReply => d.kind === 'reply' && d.threadId === thread.id,
  );
  const count = thread.comments.length;
  const open = expanded || !thread.resolved;

  async function resolve() {
    setBusy(true);
    setError(null);
    try {
      await onResolve(!thread.resolved);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function reply(body: string) {
    await onReply(body);
    setReplying(false);
  }

  return (
    <section className="thread" aria-label={`Thread on ${thread.path}`}>
      {(thread.resolved || thread.outdated) && (
        <div className="thread-head">
          {thread.resolved && (
            <button
              type="button"
              className="link-button thread-toggle"
              aria-expanded={open}
              onClick={() => setExpanded(!open)}
            >
              Resolved · {count} {count === 1 ? 'comment' : 'comments'}
            </button>
          )}
          {thread.outdated && <span className="thread-label">Outdated</span>}
        </div>
      )}
      {open && (
        <>
          {thread.comments.map((comment) => (
            <Comment key={comment.id} comment={comment} now={now} />
          ))}
          {replies.map((draft) => (
            <PendingReply
              key={draft.id}
              draft={draft}
              path={thread.path}
              onEdit={(body) => onEditDraft(draft.id, body)}
              onDelete={() => onDeleteDraft(draft.id)}
            />
          ))}
          {replying ? (
            <Composer
              target={null}
              path={thread.path}
              suggestFrom={null}
              submitLabel="Add reply"
              onSubmit={reply}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <div className="thread-actions">
              <button type="button" onClick={() => setReplying(true)}>
                Reply
              </button>
              <button type="button" disabled={busy} onClick={() => void resolve()}>
                {thread.resolved ? 'Unresolve' : 'Resolve'}
              </button>
            </div>
          )}
          {error !== null && (
            <p className="composer-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Comment({ comment, now }: { comment: ThreadComment; now: Date | undefined }) {
  return (
    <article className="thread-comment" aria-label={`Comment by ${comment.author}`}>
      <header className="comment-head">
        <span className="comment-author">{comment.author}</span>
        <time dateTime={comment.createdAt} title={comment.createdAt}>
          {relativeTime(comment.createdAt, now ?? new Date())}
        </time>
        <a href={comment.url} target="_blank" rel="noreferrer">
          view on GitHub
        </a>
      </header>
      <CommentBody body={comment.body} />
    </article>
  );
}

function PendingReply({
  draft,
  path,
  onEdit,
  onDelete,
}: {
  draft: DraftReply;
  path: string;
  onEdit: (body: string) => Promise<unknown> | void;
  onDelete: () => Promise<unknown> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: string) {
    await onEdit(body);
    setEditing(false);
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="draft-card">
      <div className="comment-head">
        <span className="pending-label">Pending</span>
      </div>
      {editing ? (
        <Composer
          target={null}
          path={path}
          suggestFrom={null}
          initial={draft.body}
          submitLabel="Save"
          onSubmit={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <CommentBody body={draft.body} />
          <div className="thread-actions">
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          </div>
        </>
      )}
      {error !== null && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const SUGGESTION = /```suggestion[^\n]*\n([\s\S]*?)\n?```/g;

/**
 * A comment body as plain text, line breaks kept. The body comes from GitHub and is not
 * trusted: no HTML and no markdown; only ```suggestion blocks get their own box.
 */
function CommentBody({ body }: { body: string }) {
  const text = body.replace(/\r\n/g, '\n');
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(SUGGESTION)) {
    pushText(parts, text.slice(last, match.index));
    parts.push(
      <figure key={`s${match.index}`} className="suggestion" aria-label="Suggested change">
        <figcaption>Suggested change</figcaption>
        <pre>
          <code>{match[1]}</code>
        </pre>
      </figure>,
    );
    last = match.index + match[0].length;
  }
  pushText(parts, text.slice(last));
  return <div className="comment-body">{parts}</div>;
}

function pushText(parts: ReactNode[], text: string) {
  const trimmed = text.replace(/^\n+|\n+$/g, '');
  if (trimmed === '') return;
  parts.push(
    <p key={`t${parts.length}`} className="comment-text">
      {trimmed}
    </p>,
  );
}

/** "just now", "5m ago", "3h ago", "2d ago"; past 30 days the date (YYYY-MM-DD). */
function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  const seconds = Math.max(0, (now.getTime() - then.getTime()) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return then.toISOString().slice(0, 10);
}
