// The browser's client for the pr-tour server's /api.

import type { InboxResponse, Job, PrResponse } from '../shared/api.js';
import type { FileDiff } from '../shared/diff.js';

/** A failed API call: the server's short `error` message and the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The server answers errors as `{ error }`; anything else (a proxy page, say) gets a generic message. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // Not JSON: fall through to the generic message below.
  }
  return `Request failed (HTTP ${res.status})`;
}

export function getInbox(): Promise<InboxResponse> {
  return request('/api/inbox');
}

export function getPr(repo: string, pr: number): Promise<PrResponse> {
  return request(prPath(repo, pr));
}

/** Starts (or joins) a tour build; returns its job. */
export function buildTour(repo: string, pr: number): Promise<{ job: Job | null }> {
  return request(`${prPath(repo, pr)}/tour`, { method: 'POST' });
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
  return request(`${prPath(repo, pr)}/seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ homeId, contentHash }),
  });
}
