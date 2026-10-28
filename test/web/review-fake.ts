import { vi } from 'vitest';
import type { Draft, ReviewThread } from '../../src/shared/review.js';
import type { ReviewState } from '../../src/web/useReview.js';

/** A ready review with `threads` and `drafts`; the actions are mocks that resolve. */
export function fakeReview(
  options: { threads?: ReviewThread[]; drafts?: Draft[]; headSha?: string } = {},
): ReviewState {
  const threads = options.threads ?? [];
  const drafts = options.drafts ?? [];
  return {
    state: 'ready',
    viewerIsAuthor: false,
    headSha: options.headSha ?? 'b'.repeat(40),
    threads,
    drafts,
    ci: { state: 'none', failing: null },
    threadsFor: (path) => threads.filter((t) => t.path === path),
    draftsFor: (path) => drafts.filter((d) => d.kind === 'comment' && d.path === path),
    add: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    submit: vi.fn(() => Promise.resolve(null)),
    submitting: false,
    submitError: null,
    resolve: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
  };
}
