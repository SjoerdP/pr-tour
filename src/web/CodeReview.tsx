// The review parts of the code view: threads and pending drafts under a code row, and the
// "Comments on this file" block above the code.

import type { ReactNode } from 'react';
import { isOlderDraft, type DraftComment, type ReviewThread } from '../shared/review.js';
import { PendingDraft, Thread } from './Thread.js';
import type { ReviewState } from './useReview.js';

type ItemsProps = {
  path: string;
  /** Head of the tour shown; drafts made on another head are labeled "older version". */
  headSha: string;
  threads: ReviewThread[];
  drafts: DraftComment[];
  review: ReviewState;
};

function Items({ path, headSha, threads, drafts, review }: ItemsProps) {
  return (
    <>
      {threads.map((thread) => (
        <Thread
          key={thread.id}
          thread={thread}
          drafts={review.drafts}
          viewerIsAuthor={review.viewerIsAuthor}
          onReply={(body) => review.add({ kind: 'reply', threadId: thread.id, body })}
          onEditDraft={(id, body) => review.update(id, body)}
          onDeleteDraft={(id) => review.remove(id)}
          onResolve={(resolved) => review.resolve(thread.id, resolved)}
        />
      ))}
      {drafts.map((draft) => (
        <PendingDraft
          key={draft.id}
          draft={draft}
          path={path}
          older={isOlderDraft(draft, headSha)}
          onEdit={(body) => review.update(draft.id, body)}
          onDelete={() => review.remove(draft.id)}
        />
      ))}
    </>
  );
}

/** What is shown under one code row: its threads, its drafts, then the open composer. */
export function ReviewRow({ composer, ...items }: ItemsProps & { composer: ReactNode }) {
  return (
    <div className="code-review-row">
      <Items {...items} />
      {composer}
    </div>
  );
}

/**
 * Threads and drafts that have no line to sit at (file-level, outdated, or made on an older
 * version), and, when given, a way to add a comment on the whole file.
 */
export function FileComments({ children, ...items }: ItemsProps & { children?: ReactNode }) {
  if (items.threads.length === 0 && items.drafts.length === 0 && !children) return null;
  return (
    <section className="file-comments" aria-label="Comments on this file">
      <h3 className="file-comments-title">Comments on this file</h3>
      <Items {...items} />
      {children}
    </section>
  );
}
