// The browser's client for the pr-tour server's /api.

import type { InboxResponse, Job, PrResponse } from '../shared/api.js';
import type { FileDiff } from '../shared/diff.js';
import type {
  Draft,
  NewDraft,
  ReviewEvent,
  ReviewResponse,
  SubmitResponse,
} from '../shared/review.js';

/**
 * A failed API call: the server's short `error` message and the HTTP status.
 * `failedDraftId` is the draft GitHub refused, when a review submit names one.
 * `drafts` is the PR's unsent draft count, when replacing its tour needs a confirmation.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failedDraftId?: number,
    readonly drafts?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** `/api/pr/:owner/:name/:pr`. `repo` is `owner/name`, as the inbox gives it. */
function prPath(repo: string, pr: number): string {
  const [owner = '', name = ''] = repo.split('/');
  return `/api/pr/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${pr}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  // The server refuses writes without this header (cross-site request guard).
  if (method !== 'GET') headers.set('X-PR-Tour', '1');
  const res = await fetch(path, { ...init, method, headers });
  if (!res.ok) {
    const { message, failedDraftId, drafts } = await errorBody(res);
    throw new ApiError(res.status, message, failedDraftId, drafts);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * The server answers errors as `{ error, failedDraftId?, drafts? }`; anything else (a proxy
 * page, say) gets a generic message.
 */
async function errorBody(
  res: Response,
): Promise<{ message: string; failedDraftId?: number; drafts?: number }> {
  let message = `Request failed (HTTP ${res.status})`;
  let failedDraftId: number | undefined;
  let drafts: number | undefined;
  try {
    const body = (await res.json()) as {
      error?: unknown;
      failedDraftId?: unknown;
      drafts?: unknown;
    };
    if (typeof body.error === 'string' && body.error !== '') message = body.error;
    if (typeof body.failedDraftId === 'number') failedDraftId = body.failedDraftId;
    if (typeof body.drafts === 'number') drafts = body.drafts;
  } catch {
    // Not JSON: keep the generic message.
  }
  return { message, failedDraftId, drafts };
}

function withJson(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function getInbox(): Promise<InboxResponse> {
  return request('/api/inbox');
}

export function getPr(repo: string, pr: number): Promise<PrResponse> {
  return request(prPath(repo, pr));
}

/**
 * Starts (or joins) a tour build; returns its job. When the PR has a tour and unsent drafts,
 * the server refuses with a 409 `ApiError` carrying `drafts` unless `replace` is true.
 */
export function buildTour(repo: string, pr: number, replace = false): Promise<{ job: Job | null }> {
  return request(`${prPath(repo, pr)}/tour`, withJson('POST', { replace }));
}

/**
 * The text of `path` at `sha`, which must be the tour's base or head commit.
 * `text` is `null` when the file does not exist at that commit.
 */
export function getFile(
  repo: string,
  pr: number,
  sha: string,
  path: string,
): Promise<{ text: string | null }> {
  const query = new URLSearchParams({ sha, path });
  return request(`${prPath(repo, pr)}/file?${query}`);
}

export function getDiff(repo: string, pr: number, file: string): Promise<FileDiff> {
  const query = new URLSearchParams({ file });
  return request(`${prPath(repo, pr)}/diff?${query}`);
}

export function markSeen(
  repo: string,
  pr: number,
  homeId: string,
  contentHash: string,
): Promise<void> {
  return request(`${prPath(repo, pr)}/seen`, withJson('POST', { homeId, contentHash }));
}

/** Threads, drafts, CI and authorship for the PR's review. */
export function getReview(repo: string, pr: number): Promise<ReviewResponse> {
  return request(`${prPath(repo, pr)}/review`);
}

/** Saves a draft locally (nothing goes to GitHub); returns it as the server stored it. */
export function addDraft(repo: string, pr: number, draft: NewDraft): Promise<Draft> {
  return request(`${prPath(repo, pr)}/drafts`, withJson('POST', draft));
}

export function updateDraft(repo: string, pr: number, id: number, body: string): Promise<Draft> {
  return request(`${prPath(repo, pr)}/drafts/${id}`, withJson('PATCH', { body }));
}

export function deleteDraft(repo: string, pr: number, id: number): Promise<void> {
  return request(`${prPath(repo, pr)}/drafts/${id}`, { method: 'DELETE' });
}

/**
 * Sends the review with all drafts to GitHub; returns the review's URL and the ids of the
 * drafts it sent. `headSha` is the head
 * of the tour the page shows: the server answers 409 when its tour has changed since.
 */
export function submitReview(
  repo: string,
  pr: number,
  event: ReviewEvent,
  body: string,
  headSha: string,
): Promise<SubmitResponse> {
  return request(`${prPath(repo, pr)}/review/submit`, withJson('POST', { event, body, headSha }));
}

/** Resolves or unresolves a thread on GitHub. */
export function setResolved(
  repo: string,
  pr: number,
  threadId: string,
  resolved: boolean,
): Promise<void> {
  return request(
    `${prPath(repo, pr)}/threads/${encodeURIComponent(threadId)}/resolve`,
    withJson('POST', { resolved }),
  );
}
