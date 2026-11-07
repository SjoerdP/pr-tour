// The review API: drafts kept in the store, and the review, threads and CI from GitHub.
// Nothing goes to GitHub until the user submits the review or (un)resolves a thread.
// Also the possible problems from CI, and the user's local marks on them.

import type { Hono } from 'hono';
import { z } from 'zod';
import type { ProblemsResponse } from '../shared/api.js';
import type { Problem } from '../shared/problems.js';
import {
  commentTarget,
  DraftPatchSchema,
  NewDraftSchema,
  quoteLines,
  SubmitBodySchema,
  type NewDraft,
  type ReviewResponse,
  type StoredNewDraft,
  type SubmitResponse,
} from '../shared/review.js';
import type { Tour } from '../shared/tour.js';
import { findFileDiff, parseDiff, type FileDiff } from './diff.js';
import { CommandError } from './exec.js';
import type { GitHub } from './github.js';
import { HttpError, jsonBody, parse, prParams } from './http.js';
import { ciProblems, type CheckRunNode, type ProblemsGitHub } from './problems-github.js';
import type { RepoManager } from './repo.js';
import { ReviewSubmitError, type ReviewGitHub } from './review-github.js';
import { StoreError, type Store } from './store.js';

export type ReviewRouteDeps = {
  review: Pick<ReviewGitHub, 'reviewState' | 'submitReview' | 'setResolved'>;
  problems: Pick<ProblemsGitHub, 'checkRuns'>;
  /** For the PR's current head, to tell whether the tour is outdated. */
  github: Pick<GitHub, 'pr'>;
  store: Store;
  repos: Pick<RepoManager, 'fileAt' | 'diffText'>;
  /** The stored tour, or null. */
  readTour: (repo: string, pr: number) => Tour | null;
  /** The stored tour; throws a 404 `HttpError` without one. */
  requireTour: (repo: string, pr: number) => Tour;
};

const OWN_PR = "You can't approve or request changes on your own PR.";
const TOUR_CHANGED = 'The tour changed. Reload the page.';

/**
 * Line numbers and a review are only right for the head the user read. When the page still
 * shows an older tour than the stored one, refuse before anything is stored or sent.
 */
function requireSameHead(tour: Tour, headSha: string): void {
  if (headSha !== tour.headSha) throw new HttpError(409, TOUR_CHANGED);
}

const DraftIdSchema = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number),
});

const ThreadIdSchema = z.object({ threadId: z.string().regex(/^[\w-]{1,100}$/) });

const ResolveBodySchema = z.object({ resolved: z.boolean() });

const ProblemMarkBodySchema = z.object({
  key: z.string().min(1).max(4000),
  mark: z.enum(['real', 'not']).nullable(),
});

/** How long CI results are kept while CI still runs; finished results are kept until restart. */
const PENDING_CACHE_MS = 60_000;

/** The check runs of one tour head, and when they were read. */
type CachedRuns = { runs: CheckRunNode[]; pending: boolean; readAt: number };

/** No problems, with a note on why. */
function failed(error: string): { problems: Problem[]; pending: boolean; error: string } {
  return { problems: [], pending: false, error };
}

/** A short reason for a failed GitHub read, fit to show the user. */
function reason(err: unknown): string {
  if (err instanceof CommandError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

const PR = '/api/pr/:owner/:name/:pr';

/** Mount the review routes under `/api/pr/:owner/:name/:pr`. */
export function registerReviewRoutes(app: Hono, deps: ReviewRouteDeps): void {
  const { review, problems, github, store, repos, readTour, requireTour } = deps;
  /**
   * PRs (`repo#pr` keys) with a review being sent. A second submit (a double click) would
   * send the same drafts again, and a review on GitHub cannot be taken back.
   */
  const submitting = new Set<string>();
  /**
   * Check runs per `repo#pr@headSha`. Only GitHub's answer is kept: the problems are worked
   * out from it on every read, because a rebuilt tour for the same head can place them
   * differently. Failed reads are not kept, so the next read tries again.
   */
  const checkRunsCache = new Map<string, CachedRuns>();

  /** The check runs of the tour's head commit, from the cache when still fresh. */
  async function tourCheckRuns(repo: string, key: string, tour: Tour): Promise<CachedRuns> {
    const cacheKey = `${key}@${tour.headSha}`;
    const cached = checkRunsCache.get(cacheKey);
    if (cached && (!cached.pending || Date.now() - cached.readAt < PENDING_CACHE_MS)) return cached;
    const fresh = { ...(await problems.checkRuns(repo, tour.headSha)), readAt: Date.now() };
    checkRunsCache.set(cacheKey, fresh);
    return fresh;
  }

  /** The tour's CI problems, or a note on why they could not be read. */
  async function tourProblems(
    repo: string,
    key: string,
    tour: Tour,
  ): Promise<{ problems: Problem[]; pending: boolean; error: string | null }> {
    let ci: CachedRuns;
    try {
      ci = await tourCheckRuns(repo, key, tour);
    } catch (err) {
      console.error(`Reading CI of ${key} failed: ${reason(err)}`);
      return failed(`Could not read CI results from GitHub: ${reason(err)}`);
    }
    let files: FileDiff[];
    try {
      files = parseDiff(await repos.diffText(repo, tour.baseSha, tour.headSha));
    } catch (err) {
      console.error(`Reading the diff of ${key} failed: ${reason(err)}`);
      return failed(`Could not read the PR's diff: ${reason(err)}`);
    }
    return { problems: ciProblems(ci.runs, files, tour), pending: ci.pending, error: null };
  }

  /** Whether the PR's head moved past the tour's; false when GitHub cannot say. */
  async function isOutdated(repo: string, pr: number, tour: Tour): Promise<boolean> {
    try {
      return (await github.pr(repo, pr)).headSha !== tour.headSha;
    } catch (err) {
      console.error(`Reading the head of ${repo}#${pr} failed: ${reason(err)}`);
      return false;
    }
  }

  /** A new comment with its placement, quote and head worked out from the tour's diff. */
  async function placeComment(
    repo: string,
    pr: number,
    draft: Extract<NewDraft, { kind: 'comment' }>,
  ): Promise<StoredNewDraft> {
    const tour = requireTour(repo, pr);
    requireSameHead(tour, draft.headSha);
    const files = parseDiff(await repos.diffText(repo, tour.baseSha, tour.headSha));
    const file = findFileDiff(files, draft.path);
    if (!file) throw new HttpError(404, `${draft.path} is not changed in this tour`);
    if (draft.side === 'new' && file.status === 'deleted') {
      throw new HttpError(400, `${file.path} is deleted; comment on the old side`);
    }
    if (draft.side === 'old' && file.status === 'added') {
      throw new HttpError(400, `${file.path} is new; comment on the new side`);
    }

    const text =
      draft.side === 'new'
        ? await repos.fileAt(repo, tour.headSha, file.path)
        : await repos.fileAt(repo, tour.baseSha, file.oldPath);
    const lines = text === null ? [] : text.split('\n');
    if (text?.endsWith('\n')) lines.pop();
    if (draft.endLine > lines.length) {
      throw new HttpError(400, `Lines ${draft.startLine}–${draft.endLine} are not in ${file.path}`);
    }
    const lineText = (n: number) => lines[n - 1] ?? '';

    const target = commentTarget(file, draft.side, draft.startLine, draft.endLine, lineText);
    return {
      kind: 'comment',
      // GitHub names a file by its new path, on both sides.
      path: file.path,
      side: draft.side,
      startLine: draft.startLine,
      endLine: draft.endLine,
      placement: target.placement,
      quote: quoteLines(draft.startLine, draft.endLine, lineText),
      headSha: tour.headSha,
      body: draft.body,
    };
  }

  app.get(`${PR}/review`, async (c) => {
    const { repo, pr } = prParams(c);
    const state = await review.reviewState(repo, pr);
    const body: ReviewResponse = {
      viewerIsAuthor: state.viewerIsAuthor,
      headSha: readTour(repo, pr)?.headSha ?? null,
      threads: state.threads,
      drafts: store.drafts(repo, pr),
      ci: state.ci,
    };
    return c.json(body);
  });

  app.post(`${PR}/drafts`, async (c) => {
    const { repo, pr } = prParams(c);
    const draft = await jsonBody(c, NewDraftSchema, 'draft');
    const stored = draft.kind === 'comment' ? await placeComment(repo, pr, draft) : draft;
    return c.json(store.addDraft(repo, pr, stored), 201);
  });

  app.patch(`${PR}/drafts/:id`, async (c) => {
    const { repo, pr } = prParams(c);
    const { id } = parse(DraftIdSchema, { id: c.req.param('id') }, 'draft id');
    const { body } = await jsonBody(c, DraftPatchSchema, 'draft');
    try {
      return c.json(store.updateDraft(repo, pr, id, body));
    } catch (err) {
      if (err instanceof StoreError) throw new HttpError(404, `No draft ${id} on ${repo}#${pr}`);
      throw err;
    }
  });

  app.delete(`${PR}/drafts/:id`, (c) => {
    const { repo, pr } = prParams(c);
    const { id } = parse(DraftIdSchema, { id: c.req.param('id') }, 'draft id');
    store.deleteDraft(repo, pr, id);
    return c.body(null, 204);
  });

  app.post(`${PR}/review/submit`, async (c) => {
    const { repo, pr, key } = prParams(c);
    const { event, body, headSha } = await jsonBody(c, SubmitBodySchema, 'review');
    const tour = requireTour(repo, pr);
    requireSameHead(tour, headSha);
    if (submitting.has(key)) throw new HttpError(409, 'A review is already being sent.');
    submitting.add(key);
    try {
      // Exactly these drafts are sent, and only these are cleared afterwards.
      const drafts = store.drafts(repo, pr);
      if (event === 'COMMENT' && body.trim() === '' && drafts.length === 0) {
        throw new HttpError(400, 'Nothing to send.');
      }
      const { prId, viewerIsAuthor } = await review.reviewState(repo, pr);
      if (viewerIsAuthor && event !== 'COMMENT') throw new HttpError(400, OWN_PR);

      let url: string;
      try {
        ({ url } = await review.submitReview({
          prId,
          commitOid: tour.headSha,
          event,
          body,
          drafts,
        }));
      } catch (err) {
        if (!(err instanceof ReviewSubmitError)) throw err;
        console.error(`Submitting the review of ${key} failed:\n${err.stack ?? err.message}`);
        return c.json({ error: err.message, failedDraftId: err.failedDraftId }, 502);
      }
      const sent = drafts.map((d) => d.id);
      store.clearDrafts(repo, pr, sent);
      const answer: SubmitResponse = { url, sent };
      return c.json(answer);
    } finally {
      submitting.delete(key);
    }
  });

  app.get(`${PR}/problems`, async (c) => {
    const { repo, pr, key } = prParams(c);
    const tour = requireTour(repo, pr);
    const [ci, outdated] = await Promise.all([
      tourProblems(repo, key, tour),
      isOutdated(repo, pr, tour),
    ]);
    const body: ProblemsResponse = {
      problems: ci.problems,
      marks: store.problemMarks(repo, pr),
      pending: ci.pending,
      outdated,
      error: ci.error,
    };
    return c.json(body);
  });

  app.post(`${PR}/problems/marks`, async (c) => {
    const { repo, pr } = prParams(c);
    const { key, mark } = await jsonBody(c, ProblemMarkBodySchema, 'problem mark');
    store.setProblemMark(repo, pr, key, mark);
    return c.body(null, 204);
  });

  app.post(`${PR}/threads/:threadId/resolve`, async (c) => {
    prParams(c);
    const { threadId } = parse(ThreadIdSchema, { threadId: c.req.param('threadId') }, 'thread id');
    const { resolved } = await jsonBody(c, ResolveBodySchema, 'resolve');
    await review.setResolved(threadId, resolved);
    return c.body(null, 204);
  });
}
