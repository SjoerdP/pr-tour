import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDraft,
  ApiError,
  buildTour,
  deleteDraft,
  getReview,
  markSeen,
  setResolved,
  submitReview,
  updateDraft,
} from '../../src/web/api.js';

function serve(status: number, body: unknown) {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The one request the mock saw. */
function sent(fetchMock: ReturnType<typeof serve>) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url, init, headers: new Headers(init.headers) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client writes', () => {
  it('buildTour posts with the X-PR-Tour header', async () => {
    const fetchMock = serve(202, { job: { state: 'running', log: [] } });

    await buildTour('acme/loans', 42);

    const { url, init, headers } = sent(fetchMock);
    expect(url).toBe('/api/pr/acme/loans/42/tour');
    expect(init.method).toBe('POST');
    expect(headers.get('X-PR-Tour')).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({ replace: false });
  });

  it('buildTour with replace posts replace: true', async () => {
    const fetchMock = serve(202, { job: { state: 'running', log: [] } });

    await buildTour('acme/loans', 42, true);

    expect(JSON.parse(sent(fetchMock).init.body as string)).toEqual({ replace: true });
  });

  it('a 409 for a tour with drafts carries the draft count', async () => {
    serve(409, { error: 'This PR has 2 unsent drafts.', drafts: 2 });

    const err = await buildTour('acme/loans', 42).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, drafts: 2 });
  });

  it('markSeen posts the home id and content hash as JSON', async () => {
    const fetchMock = serve(204, null);

    await markSeen('acme/loans', 42, 'F1.S1', 'h-s1');

    const { url, init, headers } = sent(fetchMock);
    expect(url).toBe('/api/pr/acme/loans/42/seen');
    expect(init.method).toBe('POST');
    expect(headers.get('X-PR-Tour')).toBe('1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ homeId: 'F1.S1', contentHash: 'h-s1' });
  });
});

describe('api client review', () => {
  it('getReview gets the review without the write header', async () => {
    const review = {
      viewerIsAuthor: false,
      headSha: 'h1',
      threads: [],
      drafts: [],
      ci: { state: 'none', failing: null },
    };
    const fetchMock = serve(200, review);

    expect(await getReview('acme/loans', 42)).toEqual(review);

    const { url, init, headers } = sent(fetchMock);
    expect(url).toBe('/api/pr/acme/loans/42/review');
    expect(init.method).toBe('GET');
    expect(headers.get('X-PR-Tour')).toBeNull();
  });

  it('addDraft posts the new draft as JSON', async () => {
    const draft = { kind: 'reply', threadId: 't1', body: 'Yes' } as const;
    const fetchMock = serve(201, { ...draft, id: 3, createdAt: 'now' });

    expect(await addDraft('acme/loans', 42, draft)).toMatchObject({ id: 3 });

    const { url, init, headers } = sent(fetchMock);
    expect(url).toBe('/api/pr/acme/loans/42/drafts');
    expect(init.method).toBe('POST');
    expect(headers.get('X-PR-Tour')).toBe('1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(draft);
  });

  it('updateDraft patches the body', async () => {
    const fetchMock = serve(200, {
      id: 3,
      kind: 'reply',
      threadId: 't1',
      body: 'New',
      createdAt: 'now',
    });

    expect(await updateDraft('acme/loans', 42, 3, 'New')).toMatchObject({ body: 'New' });

    const { url, init, headers } = sent(fetchMock);
    expect(url).toBe('/api/pr/acme/loans/42/drafts/3');
    expect(init.method).toBe('PATCH');
    expect(headers.get('X-PR-Tour')).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({ body: 'New' });
  });

  it('deleteDraft deletes', async () => {
    const fetchMock = serve(204, null);

    await deleteDraft('acme/loans', 42, 3);

    const { url, init, headers } = sent(fetchMock);
    expect(url).toBe('/api/pr/acme/loans/42/drafts/3');
    expect(init.method).toBe('DELETE');
    expect(headers.get('X-PR-Tour')).toBe('1');
  });

  it('submitReview posts the event and body and returns the url', async () => {
    const fetchMock = serve(200, { url: 'https://github.com/r' });

    expect(await submitReview('acme/loans', 42, 'APPROVE', 'LGTM', 'h1')).toEqual({
      url: 'https://github.com/r',
    });

    const { url, init, headers } = sent(fetchMock);
    expect(url).toBe('/api/pr/acme/loans/42/review/submit');
    expect(init.method).toBe('POST');
    expect(headers.get('X-PR-Tour')).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({
      event: 'APPROVE',
      body: 'LGTM',
      headSha: 'h1',
    });
  });

  it('a failed submit carries the failed draft id', async () => {
    serve(502, { error: 'GitHub said no', failedDraftId: 7 });

    const err = await submitReview('acme/loans', 42, 'COMMENT', '', 'h1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, message: 'GitHub said no', failedDraftId: 7 });
  });

  it('an error without a failed draft has no failedDraftId', async () => {
    serve(409, { error: 'A review is already being sent.' });

    const err = await submitReview('acme/loans', 42, 'COMMENT', '', 'h1').catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 409, failedDraftId: undefined });
  });

  it('setResolved posts the resolved flag for the thread', async () => {
    const fetchMock = serve(204, null);

    await setResolved('acme/loans', 42, 'PRRT_x/1', true);

    const { url, init, headers } = sent(fetchMock);
    expect(url).toBe('/api/pr/acme/loans/42/threads/PRRT_x%2F1/resolve');
    expect(init.method).toBe('POST');
    expect(headers.get('X-PR-Tour')).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({ resolved: true });
  });
});
