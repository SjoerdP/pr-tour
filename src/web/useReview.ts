import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CiStatus,
  Draft,
  NewDraft,
  ReviewEvent,
  ReviewResponse,
  ReviewThread,
} from '../shared/review.js';
import {
  addDraft,
  ApiError,
  deleteDraft,
  getReview,
  setResolved,
  submitReview,
  updateDraft,
} from './api.js';
import { errorText } from './errors.js';

/** Why the last submit failed; `failedDraftId` is the draft GitHub refused, if it named one. */
export type SubmitError = { message: string; failedDraftId: number | null };

export type ReviewState = {
  state: 'loading' | 'ready' | 'error';
  /** Set when `state` is `error`. */
  error?: string;
  viewerIsAuthor: boolean;
  /** Head of the current tour; null without a tour (or before loading). */
  headSha: string | null;
  threads: ReviewThread[];
  drafts: Draft[];
  ci: CiStatus;
  /** Threads on `path`. */
  threadsFor: (path: string) => ReviewThread[];
  /** Comment drafts on `path` (replies belong to their thread, not a path). */
  draftsFor: (path: string) => Draft[];
  /** These reject with the server's error and leave the drafts as they were. */
  add: (draft: NewDraft) => Promise<void>;
  update: (id: number, body: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
  /**
   * Sends the review. Returns its URL and reloads, or returns null and sets `submitError`.
   * Also returns null, without a request, while a submit is already in flight.
   */
  submit: (event: ReviewEvent, body: string) => Promise<{ url: string } | null>;
  submitting: boolean;
  submitError: SubmitError | null;
  /** Resolves or unresolves a thread on GitHub; rejects with the server's error. */
  resolve: (threadId: string, resolved: boolean) => Promise<void>;
  reload: () => Promise<void>;
};

/** A load result, for the PR named by `key` (`repo#pr`). */
type Load =
  | { key: string; state: 'error'; error: string }
  | { key: string; state: 'ready'; data: ReviewResponse };

const NO_CI: CiStatus = { state: 'none', failing: null };

/**
 * The PR's review: threads, local drafts and CI from the server, and the actions on them.
 * Drafts change only from the server's answers (nothing optimistic). Nothing reaches
 * GitHub until `submit` or `resolve`.
 */
export function useReview(repo: string, pr: number): ReviewState {
  const key = `${repo}#${pr}`;
  const [stored, setLoad] = useState<Load | null>(null);
  // A result for another PR counts as still loading this one.
  const load = stored?.key === key ? stored : ({ state: 'loading' } as const);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const inFlight = useRef(false);
  // Which load is current: answers to older loads are dropped.
  const loadId = useRef(0);

  // Loads the review into state; answers to an older load than the latest are dropped.
  const fetchReview = useCallback((): Promise<void> => {
    const id = ++loadId.current;
    const k = `${repo}#${pr}`;
    return getReview(repo, pr).then(
      (data) => {
        if (id === loadId.current) setLoad({ key: k, state: 'ready', data });
      },
      (err: unknown) => {
        if (id === loadId.current) setLoad({ key: k, state: 'error', error: errorText(err) });
      },
    );
  }, [repo, pr]);

  useEffect(() => {
    void fetchReview();
  }, [fetchReview]);

  const reload = fetchReview;

  function patch(change: (data: ReviewResponse) => ReviewResponse) {
    setLoad((prev) =>
      prev?.key === key && prev.state === 'ready' ? { ...prev, data: change(prev.data) } : prev,
    );
  }

  async function add(draft: NewDraft) {
    const saved = await addDraft(repo, pr, draft);
    patch((d) => ({ ...d, drafts: [...d.drafts, saved] }));
  }

  async function update(id: number, body: string) {
    const saved = await updateDraft(repo, pr, id, body);
    patch((d) => ({ ...d, drafts: d.drafts.map((x) => (x.id === id ? saved : x)) }));
  }

  async function remove(id: number) {
    await deleteDraft(repo, pr, id);
    patch((d) => ({ ...d, drafts: d.drafts.filter((x) => x.id !== id) }));
  }

  async function submit(event: ReviewEvent, body: string) {
    if (inFlight.current) return null;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitReview(repo, pr, event, body);
      await reload();
      return result;
    } catch (err) {
      setSubmitError({
        message: errorText(err),
        failedDraftId: err instanceof ApiError ? (err.failedDraftId ?? null) : null,
      });
      return null;
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function resolve(threadId: string, resolved: boolean) {
    await setResolved(repo, pr, threadId, resolved);
    patch((d) => ({
      ...d,
      threads: d.threads.map((t) => (t.id === threadId ? { ...t, resolved } : t)),
    }));
  }

  const data = load.state === 'ready' ? load.data : null;
  const threads = data?.threads ?? [];
  const drafts = data?.drafts ?? [];

  return {
    state: load.state,
    ...(load.state === 'error' ? { error: load.error } : {}),
    viewerIsAuthor: data?.viewerIsAuthor ?? false,
    headSha: data?.headSha ?? null,
    threads,
    drafts,
    ci: data?.ci ?? NO_CI,
    threadsFor: (path) => threads.filter((t) => t.path === path),
    draftsFor: (path) => drafts.filter((d) => d.kind === 'comment' && d.path === path),
    add,
    update,
    remove,
    submit,
    submitting,
    submitError,
    resolve,
    reload,
  };
}
