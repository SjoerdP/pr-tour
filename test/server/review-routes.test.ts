import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { finishTour, type TourBuilder } from '../../src/server/build.js';
import { parseDiff } from '../../src/server/diff.js';
import { CommandError } from '../../src/server/exec.js';
import type { GitHub } from '../../src/server/github.js';
import { GraphqlError } from '../../src/server/graphql.js';
import { Jobs } from '../../src/server/jobs.js';
import type { RepoManager } from '../../src/server/repo.js';
import { ReviewSubmitError, type ReviewGitHub } from '../../src/server/review-github.js';
import { Store } from '../../src/server/store.js';
import type { CiStatus, Draft, ReviewResponse, ReviewThread } from '../../src/shared/review.js';
import type { Tour } from '../../src/shared/tour.js';

const PORT = 4317;
const HOST = `localhost:${PORT}`;
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OLD_HEAD = 'c'.repeat(40);
const URL_BASE = '/api/pr/acme/greet/7';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

// modified.diff: greet.js deletes old 2-3 and adds new 2-4, in one hunk over new 1-7.
const DIFF = fixture('modified.diff');

/** The head (or base) file: line n reads `<side> line n`, 15 lines. */
function fileText(side: string): string {
  return Array.from({ length: 15 }, (_, i) => `${side} line ${i + 1}\n`).join('');
}

function greetTour(diff = DIFF, file = 'greet.js'): Tour {
  return finishTour(
    {
      summary: 'Renames the greeting parts.',
      foundations: [],
      flows: [],
      other: [
        {
          kind: 'refactor',
          title: 'Refactor',
          summary: 'Renames.',
          items: [{ file, title: 'Change', homes: [] }],
        },
      ],
    },
    {
      repo: 'acme/greet',
      pr: 7,
      baseSha: BASE,
      headSha: HEAD,
      source: 'inferred',
      createdAt: '2026-10-28T12:00:00.000Z',
    },
    parseDiff(diff),
  );
}

const CI: CiStatus = { state: 'failure', failing: { name: 'test', url: 'https://ci/1' } };

const THREAD: ReviewThread = {
  id: 'T1',
  path: 'greet.js',
  side: 'new',
  line: 2,
  startLine: null,
  outdated: false,
  resolved: false,
  comments: [],
};

type Fakes = {
  github: { inbox: Mock<GitHub['inbox']>; pr: Mock<GitHub['pr']> };
  repos: { fileAt: Mock<RepoManager['fileAt']>; diffText: Mock<RepoManager['diffText']> };
  builder: { build: Mock<TourBuilder['build']> };
  review: {
    reviewState: Mock<ReviewGitHub['reviewState']>;
    submitReview: Mock<ReviewGitHub['submitReview']>;
    setResolved: Mock<ReviewGitHub['setResolved']>;
  };
  store: Store;
  jobs: Jobs;
};

let fakes: Fakes;
let app: ReturnType<typeof createApp>;

/** reviewState answers as for a PR by someone else, unless `viewerIsAuthor`. */
function reviewState(viewerIsAuthor = false) {
  fakes.review.reviewState.mockResolvedValue({
    prId: 'PR_7',
    viewerIsAuthor,
    threads: [THREAD],
    ci: CI,
  });
}

beforeEach(() => {
  fakes = {
    github: { inbox: vi.fn<GitHub['inbox']>(), pr: vi.fn<GitHub['pr']>() },
    repos: {
      fileAt: vi
        .fn<RepoManager['fileAt']>()
        .mockImplementation((_repo, sha) =>
          Promise.resolve(fileText(sha === HEAD ? 'new' : 'old')),
        ),
      diffText: vi.fn<RepoManager['diffText']>().mockResolvedValue(DIFF),
    },
    builder: { build: vi.fn<TourBuilder['build']>() },
    review: {
      reviewState: vi.fn<ReviewGitHub['reviewState']>(),
      submitReview: vi
        .fn<ReviewGitHub['submitReview']>()
        .mockResolvedValue({ url: 'https://github.com/acme/greet/pull/7#review-1' }),
      setResolved: vi.fn<ReviewGitHub['setResolved']>().mockResolvedValue(undefined),
    },
    store: new Store(':memory:'),
    jobs: new Jobs(),
  };
  reviewState();
  app = createApp({ ...fakes, port: PORT });
});

afterEach(() => {
  fakes.store.close();
  vi.restoreAllMocks();
});

function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Host: HOST };
  if (method !== 'GET') headers['X-PR-Tour'] = '1';
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(`${URL_BASE}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function captureErrorLog() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function addReply(body = 'reply', threadId = 'T1'): Draft {
  return fakes.store.addDraft('acme/greet', 7, { kind: 'reply', threadId, body });
}

describe('GET /review', () => {
  it('GET review returns threads, drafts, ci', async () => {
    fakes.store.saveTour(greetTour());
    const draft = addReply();

    const res = await api('/review');

    expect(res.status).toBe(200);
    expect(await json<ReviewResponse>(res)).toEqual({
      viewerIsAuthor: false,
      headSha: HEAD,
      threads: [THREAD],
      drafts: [draft],
      ci: CI,
    });
    expect(fakes.review.reviewState).toHaveBeenCalledWith('acme/greet', 7);
  });

  it('GET review without a tour has headSha null', async () => {
    const res = await api('/review');
    expect((await json<ReviewResponse>(res)).headSha).toBeNull();
  });

  it('a GraphQL failure is 502 with a short message', async () => {
    const log = captureErrorLog();
    fakes.review.reviewState.mockRejectedValue(new GraphqlError('Something went wrong'));

    const res = await api('/review');

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Something went wrong' });
    expect(log).toHaveBeenCalled();
  });

  it('a gh failure is 502 with the short message', async () => {
    captureErrorLog();
    fakes.review.reviewState.mockRejectedValue(
      new CommandError('gh', ['api', 'graphql', '-f', 'query=secret'], {
        stdout: '',
        stderr: 'HTTP 401: Bad credentials',
        code: 1,
      }),
    );

    const res = await api('/review');

    expect(res.status).toBe(502);
    const { error } = await json<{ error: string }>(res);
    expect(error).toContain('Bad credentials');
    expect(error).not.toContain('query=secret');
  });
});

describe('POST /drafts', () => {
  beforeEach(() => fakes.store.saveTour(greetTour()));

  it('POST draft computes placement, quote and headSha server-side', async () => {
    const res = await api('/drafts', {
      method: 'POST',
      body: {
        kind: 'comment',
        path: 'greet.js',
        side: 'new',
        startLine: 2,
        endLine: 4,
        headSha: HEAD,
        body: 'hi',
      },
    });

    expect(res.status).toBe(201);
    const draft = await json<Draft>(res);
    expect(draft).toMatchObject({
      kind: 'comment',
      path: 'greet.js',
      side: 'new',
      startLine: 2,
      endLine: 4,
      placement: 'line',
      quote: 'new line 2\nnew line 3\nnew line 4',
      headSha: HEAD,
      body: 'hi',
    });
    expect(fakes.store.drafts('acme/greet', 7)).toEqual([draft]);
    expect(fakes.repos.fileAt).toHaveBeenCalledWith('acme/greet', HEAD, 'greet.js');
  });

  it('a comment outside the hunks is file-level and quotes at most 10 lines', async () => {
    const res = await api('/drafts', {
      method: 'POST',
      body: {
        kind: 'comment',
        path: 'greet.js',
        side: 'new',
        startLine: 3,
        endLine: 14,
        headSha: HEAD,
        body: 'x',
      },
    });

    const draft = await json<Draft>(res);
    const quoted = Array.from({ length: 10 }, (_, i) => `new line ${i + 3}`).join('\n');
    expect(draft).toMatchObject({ placement: 'file', quote: `${quoted}\n…` });
  });

  it('an old-side comment reads the base file', async () => {
    const res = await api('/drafts', {
      method: 'POST',
      body: {
        kind: 'comment',
        path: 'greet.js',
        side: 'old',
        startLine: 2,
        endLine: 3,
        headSha: HEAD,
        body: 'x',
      },
    });

    expect(await json<Draft>(res)).toMatchObject({
      placement: 'line',
      side: 'old',
      quote: 'old line 2\nold line 3',
    });
    expect(fakes.repos.fileAt).toHaveBeenCalledWith('acme/greet', BASE, 'greet.js');
  });

  it('a comment on the old side of a renamed file reads the old path and keeps the new path', async () => {
    const diff = fixture('renamed.diff');
    const file = parseDiff(diff)[0]!;
    fakes.repos.diffText.mockResolvedValue(diff);
    fakes.store.saveTour(greetTour(diff, file.path));

    const res = await api('/drafts', {
      method: 'POST',
      body: {
        kind: 'comment',
        path: file.path,
        side: 'old',
        startLine: 1,
        endLine: 1,
        headSha: HEAD,
        body: 'x',
      },
    });

    expect(res.status).toBe(201);
    expect(await json<Draft>(res)).toMatchObject({ path: file.path });
    expect(fakes.repos.fileAt).toHaveBeenCalledWith('acme/greet', BASE, file.oldPath);
  });

  it.each([
    ['added.diff', 'old'],
    ['deleted.diff', 'new'],
  ])('a comment on the missing side of a file in %s is 400', async (name, side) => {
    const diff = fixture(name);
    const file = parseDiff(diff)[0]!;
    fakes.repos.diffText.mockResolvedValue(diff);
    fakes.store.saveTour(greetTour(diff, file.path));

    const res = await api('/drafts', {
      method: 'POST',
      body: {
        kind: 'comment',
        path: file.path,
        side,
        startLine: 1,
        endLine: 1,
        headSha: HEAD,
        body: 'x',
      },
    });

    expect(res.status).toBe(400);
    expect(fakes.store.draftCount('acme/greet', 7)).toBe(0);
  });

  it('a comment on a file not in the tour is 404', async () => {
    const res = await api('/drafts', {
      method: 'POST',
      body: {
        kind: 'comment',
        path: 'other.js',
        side: 'new',
        startLine: 1,
        endLine: 1,
        headSha: HEAD,
        body: 'x',
      },
    });
    expect(res.status).toBe(404);
  });

  it('a comment past the end of the file is 400', async () => {
    const res = await api('/drafts', {
      method: 'POST',
      body: {
        kind: 'comment',
        path: 'greet.js',
        side: 'new',
        startLine: 15,
        endLine: 16,
        headSha: HEAD,
        body: 'x',
      },
    });
    expect(res.status).toBe(400);
  });

  it('a comment without a tour is 404', async () => {
    fakes.store.close();
    fakes.store = new Store(':memory:');
    app = createApp({ ...fakes, port: PORT });

    const res = await api('/drafts', {
      method: 'POST',
      body: {
        kind: 'comment',
        path: 'greet.js',
        side: 'new',
        startLine: 2,
        endLine: 2,
        headSha: HEAD,
        body: 'x',
      },
    });
    expect(res.status).toBe(404);
  });

  it('a reply needs no tour and is stored as sent', async () => {
    const res = await api('/drafts', {
      method: 'POST',
      body: { kind: 'reply', threadId: 'T1', body: 'agreed' },
    });

    expect(res.status).toBe(201);
    expect(await json<Draft>(res)).toMatchObject({ kind: 'reply', threadId: 'T1', body: 'agreed' });
    expect(fakes.repos.diffText).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'reply', threadId: '', body: 'x' },
    { kind: 'reply', threadId: 'T1', body: '' },
    { kind: 'comment', path: 'greet.js', side: 'new', startLine: 3, endLine: 2, body: 'x' },
    { kind: 'other' },
  ])('an invalid draft %j is 400', async (body) => {
    const res = await api('/drafts', { method: 'POST', body });
    expect(res.status).toBe(400);
  });
});

describe('POST /drafts on a replaced tour', () => {
  beforeEach(() => fakes.store.saveTour(greetTour()));

  it('a comment made on another head than the stored tour is 409, nothing stored or read', async () => {
    const res = await api('/drafts', {
      method: 'POST',
      body: {
        kind: 'comment',
        path: 'greet.js',
        side: 'new',
        startLine: 2,
        endLine: 2,
        headSha: OLD_HEAD,
        body: 'x',
      },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The tour changed. Reload the page.' });
    expect(fakes.store.draftCount('acme/greet', 7)).toBe(0);
    expect(fakes.repos.diffText).not.toHaveBeenCalled();
    expect(fakes.review.reviewState).not.toHaveBeenCalled();
  });

  it('a comment without headSha is 400', async () => {
    const res = await api('/drafts', {
      method: 'POST',
      body: { kind: 'comment', path: 'greet.js', side: 'new', startLine: 2, endLine: 2, body: 'x' },
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH and DELETE /drafts/:id', () => {
  it('PATCH changes the body', async () => {
    const draft = addReply('old');

    const res = await api(`/drafts/${draft.id}`, { method: 'PATCH', body: { body: 'new' } });

    expect(res.status).toBe(200);
    expect(await json<Draft>(res)).toMatchObject({ id: draft.id, body: 'new' });
    expect(fakes.store.drafts('acme/greet', 7)[0]).toMatchObject({ body: 'new' });
  });

  it("PATCH of another PR's draft is 404", async () => {
    const other = fakes.store.addDraft('acme/greet', 8, {
      kind: 'reply',
      threadId: 'T',
      body: 'a',
    });

    const res = await api(`/drafts/${other.id}`, { method: 'PATCH', body: { body: 'new' } });

    expect(res.status).toBe(404);
    expect(fakes.store.drafts('acme/greet', 8)[0]).toMatchObject({ body: 'a' });
  });

  it('PATCH with an empty body is 400', async () => {
    const draft = addReply();
    const res = await api(`/drafts/${draft.id}`, { method: 'PATCH', body: { body: '' } });
    expect(res.status).toBe(400);
  });

  it("DELETE of another PR's draft leaves it", async () => {
    const other = fakes.store.addDraft('acme/greet', 8, {
      kind: 'reply',
      threadId: 'T',
      body: 'a',
    });

    const res = await api(`/drafts/${other.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(fakes.store.drafts('acme/greet', 8)).toEqual([other]);
  });

  it('DELETE removes the draft', async () => {
    const draft = addReply();

    const res = await api(`/drafts/${draft.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(fakes.store.draftCount('acme/greet', 7)).toBe(0);
  });

  it.each(['abc', '0', '1.5'])('a draft id %s is 400', async (id) => {
    const res = await api(`/drafts/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });
});

describe('POST /review/submit', () => {
  beforeEach(() => fakes.store.saveTour(greetTour()));

  it('submit own PR with APPROVE → 400', async () => {
    reviewState(true);
    addReply();

    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'APPROVE', body: 'lgtm', headSha: HEAD },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "You can't approve or request changes on your own PR.",
    });
    expect(fakes.review.submitReview).not.toHaveBeenCalled();
  });

  it('submit own PR with COMMENT is allowed', async () => {
    reviewState(true);

    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'COMMENT', body: 'note', headSha: HEAD },
    });

    expect(res.status).toBe(200);
  });

  it('submit with nothing → 400', async () => {
    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'COMMENT', body: '', headSha: HEAD },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Nothing to send.' });
    expect(fakes.review.submitReview).not.toHaveBeenCalled();
  });

  it('an APPROVE with no body and no drafts is sent', async () => {
    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'APPROVE', body: '', headSha: HEAD },
    });
    expect(res.status).toBe(200);
  });

  it('submit uses tour headSha and clears only submitted drafts', async () => {
    const sent = addReply('first');
    let late: Draft | undefined;
    fakes.review.submitReview.mockImplementation(() => {
      // A draft added while the review is being sent stays for the next review.
      late = addReply('late');
      return Promise.resolve({ url: 'https://github.com/acme/greet/pull/7#review-1' });
    });

    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'REQUEST_CHANGES', body: 'please fix', headSha: HEAD },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://github.com/acme/greet/pull/7#review-1' });
    expect(fakes.review.submitReview).toHaveBeenCalledWith({
      prId: 'PR_7',
      commitOid: HEAD,
      event: 'REQUEST_CHANGES',
      body: 'please fix',
      drafts: [sent],
    });
    expect(fakes.store.drafts('acme/greet', 7)).toEqual([late]);
  });

  it('submit failure → 502 with failedDraftId, drafts kept', async () => {
    captureErrorLog();
    const draft = addReply();
    fakes.review.submitReview.mockRejectedValue(
      new ReviewSubmitError('Line is outside the diff', draft.id),
    );

    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'COMMENT', body: '', headSha: HEAD },
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Line is outside the diff',
      failedDraftId: draft.id,
    });
    expect(fakes.store.drafts('acme/greet', 7)).toEqual([draft]);
  });

  it('a second submit while one is being sent is 409, and the lock is released after', async () => {
    addReply();
    let release!: () => void;
    fakes.review.submitReview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ url: 'https://github.com/acme/greet/pull/7#review-1' });
        }),
    );
    const submit = () =>
      api('/review/submit', {
        method: 'POST',
        body: { event: 'COMMENT', body: 'x', headSha: HEAD },
      });

    const first = submit();
    await vi.waitFor(() => expect(fakes.review.submitReview).toHaveBeenCalledTimes(1));
    const second = await submit();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'A review is already being sent.' });

    release();
    expect((await first).status).toBe(200);
    expect((await submit()).status).toBe(200);
    expect(fakes.review.submitReview).toHaveBeenCalledTimes(2);
  });

  it('the submit lock is released after a ReviewSubmitError', async () => {
    captureErrorLog();
    const draft = addReply();
    fakes.review.submitReview.mockRejectedValueOnce(new ReviewSubmitError('refused', draft.id));
    const submit = () =>
      api('/review/submit', {
        method: 'POST',
        body: { event: 'COMMENT', body: '', headSha: HEAD },
      });

    expect((await submit()).status).toBe(502);
    expect((await submit()).status).toBe(200);
  });

  it('a submit of the same PR spelled in another case is locked too', async () => {
    let release!: () => void;
    fakes.review.submitReview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ url: 'u' });
        }),
    );
    const first = api('/review/submit', {
      method: 'POST',
      body: { event: 'COMMENT', body: 'x', headSha: HEAD },
    });
    await vi.waitFor(() => expect(fakes.review.submitReview).toHaveBeenCalledTimes(1));

    const second = await app.request('/api/pr/Acme/Greet/7/review/submit', {
      method: 'POST',
      headers: { Host: HOST, 'X-PR-Tour': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'COMMENT', body: 'x', headSha: HEAD }),
    });
    expect(second.status).toBe(409);
    release();
    await first;
  });

  it('a submit failing before GitHub is reached also releases the lock', async () => {
    captureErrorLog();
    fakes.review.reviewState.mockRejectedValueOnce(new GraphqlError('down'));
    const submit = () =>
      api('/review/submit', {
        method: 'POST',
        body: { event: 'COMMENT', body: 'x', headSha: HEAD },
      });

    expect((await submit()).status).toBe(502);
    expect((await submit()).status).toBe(200);
  });

  it('submit without a tour is 404', async () => {
    fakes.store.close();
    fakes.store = new Store(':memory:');
    app = createApp({ ...fakes, port: PORT });

    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'COMMENT', body: 'x', headSha: HEAD },
    });

    expect(res.status).toBe(404);
  });

  it('submit with an unknown event is 400', async () => {
    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'MERGE', body: 'x', headSha: HEAD },
    });
    expect(res.status).toBe(400);
  });

  it(`a draft made on an older head is submitted against the tour's head`, async () => {
    const draft = fakes.store.addDraft('acme/greet', 7, {
      kind: 'comment',
      path: 'greet.js',
      side: 'new',
      startLine: 2,
      endLine: 2,
      placement: 'line',
      quote: 'x',
      headSha: OLD_HEAD,
      body: 'b',
    });

    await api('/review/submit', {
      method: 'POST',
      body: { event: 'COMMENT', body: '', headSha: HEAD },
    });

    expect(fakes.review.submitReview).toHaveBeenCalledWith(
      expect.objectContaining({ commitOid: HEAD, drafts: [draft] }),
    );
  });
});

describe('POST /review/submit on a replaced tour', () => {
  beforeEach(() => fakes.store.saveTour(greetTour()));

  it('a submit made on another head than the stored tour is 409, before GitHub', async () => {
    const draft = addReply();

    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'COMMENT', body: 'x', headSha: OLD_HEAD },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The tour changed. Reload the page.' });
    expect(fakes.review.reviewState).not.toHaveBeenCalled();
    expect(fakes.review.submitReview).not.toHaveBeenCalled();
    expect(fakes.store.drafts('acme/greet', 7)).toEqual([draft]);
  });

  it('a submit without headSha is 400', async () => {
    const res = await api('/review/submit', {
      method: 'POST',
      body: { event: 'COMMENT', body: 'x' },
    });
    expect(res.status).toBe(400);
    expect(fakes.review.submitReview).not.toHaveBeenCalled();
  });
});

describe('POST /threads/:threadId/resolve', () => {
  it('resolve', async () => {
    const res = await api('/threads/T1/resolve', { method: 'POST', body: { resolved: true } });

    expect(res.status).toBe(204);
    expect(fakes.review.setResolved).toHaveBeenCalledWith('T1', true);
  });

  it('unresolve', async () => {
    await api('/threads/T1/resolve', { method: 'POST', body: { resolved: false } });
    expect(fakes.review.setResolved).toHaveBeenCalledWith('T1', false);
  });

  it.each(['a'.repeat(101), 'T1.x', 'T%201'])('a thread id %s is 400', async (id) => {
    const res = await api(`/threads/${id}/resolve`, { method: 'POST', body: { resolved: true } });
    expect(res.status).toBe(400);
    expect(fakes.review.setResolved).not.toHaveBeenCalled();
  });

  it('a GitHub-style thread id is accepted', async () => {
    const res = await api('/threads/PRRT_kwDOA-b_12/resolve', {
      method: 'POST',
      body: { resolved: true },
    });
    expect(res.status).toBe(204);
  });

  it('a body without resolved is 400', async () => {
    const res = await api('/threads/T1/resolve', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect(fakes.review.setResolved).not.toHaveBeenCalled();
  });

  it('resolve without X-PR-Tour is rejected', async () => {
    const res = await app.request(`${URL_BASE}/threads/T1/resolve`, {
      method: 'POST',
      headers: { Host: HOST, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: true }),
    });
    expect(res.status).toBe(403);
    expect(fakes.review.setResolved).not.toHaveBeenCalled();
  });
});
