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
  /**
   * Why loading failed. Set when `state` is `error`, or when `state` is `ready` and a
   * reload failed (the data from before stays).
   */
  error?: string;
  viewerIsAuthor: boolean;
  /**
   * Head of the stored tour when the review was loaded; null without a tour (or before
   * loading). It can lag behind a rebuild: views label drafts by the tour they show.
   */
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
   * Sends the review, made on the tour with `headSha`. Returns its URL and reloads, or returns
   * null and sets `submitError`. Also returns null, without a request, while a submit is
   * already in flight.
   */
  submit: (event: ReviewEvent, body: string, headSha: string) => Promise<{ url: string } | null>;
  submitting: boolean;
  submitError: SubmitError | null;
  /** Resolves or unresolves a thread on GitHub; rejects with the server's error. */
  resolve: (threadId: string, resolved: boolean) => Promise<void>;
  reload: () => Promise<void>;
};

/** A load result, for the PR named by `key` (`repo#pr`). */
type Load =
  | { key: string; state: 'error'; error: string }
  | { key: string; state: 'ready'; data: ReviewResponse; error?: string };

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
  // PRs with a submit in flight; the ref blocks a second submit within one tick.
  const [sending, setSending] = useState<string[]>([]);
  const inFlight = useRef(new Set<string>());
  const [failed, setFailed] = useState<{ key: string; error: SubmitError } | null>(null);
  const submitting = sending.includes(key);
  const submitError = failed?.key === key ? failed.error : null;
  // Which load is current: answers to older loads, or loads older than a change, are dropped.
  const loadId = useRef(0);
  // The PR shown now, for async work that started on another one.
  const currentKey = useRef(key);
  useEffect(() => {
    currentKey.current = key;
  }, [key]);

  // Loads the review into state; answers to an older load than the latest are dropped.
  const fetchReview = useCallback((): Promise<void> => {
    const id = ++loadId.current;
    const k = `${repo}#${pr}`;
    return getReview(repo, pr).then(
      (data) => {
        if (id === loadId.current) setLoad({ key: k, state: 'ready', data });
      },
      (err: unknown) => {
        if (id !== loadId.current) return;
        const error = errorText(err);
        // A failed reload keeps the data it has and only reports the error.
        setLoad((prev) =>
          prev?.key === k && prev.state === 'ready'
            ? { ...prev, error }
            : { key: k, state: 'error', error },
        );
      },
    );
  }, [repo, pr]);

  useEffect(() => {
    void fetchReview();
  }, [fetchReview]);

  const reload = fetchReview;

  function patch(change: (data: ReviewResponse) => ReviewResponse) {
    // `key` and `stored` are from the render that started the change. After a switch to
    // another PR the change is for a PR no longer shown: touching `loadId` would cancel the
    // new PR's load, and switching back loads afresh anyway.
    if (currentKey.current !== key) return;
    // A load that started before this change would undo it: drop it. Only while ready, so
    // the first load is never dropped (there is nothing to change before it).
    if (stored?.key === key && stored.state === 'ready') loadId.current++;
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

  async function submit(event: ReviewEvent, body: string, headSha: string) {
    const k = key;
    if (inFlight.current.has(k)) return null;
    inFlight.current.add(k);
    setSending((prev) => [...prev, k]);
    setFailed((prev) => (prev?.key === k ? null : prev));
    try {
      const result = await submitReview(repo, pr, event, body, headSha);
      // After a switch to another PR, reloading this one would cancel that PR's load.
      if (currentKey.current === k) await reload();
      return result;
    } catch (err) {
      const error = {
        message: errorText(err),
        failedDraftId: err instanceof ApiError ? (err.failedDraftId ?? null) : null,
      };
      setFailed({ key: k, error });
      return null;
    } finally {
      inFlight.current.delete(k);
      setSending((prev) => prev.filter((x) => x !== k));
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
    ...(load.state !== 'loading' && load.error !== undefined ? { error: load.error } : {}),
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
