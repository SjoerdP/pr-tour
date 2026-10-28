import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draft, ReviewResponse, ReviewThread } from '../../src/shared/review.js';
import { useReview } from '../../src/web/useReview.js';

function thread(id: string, path: string, resolved = false): ReviewThread {
  return {
    id,
    path,
    side: 'new',
    line: 3,
    startLine: null,
    outdated: false,
    resolved,
    comments: [],
  };
}

function comment(id: number, path: string, body = 'Hm'): Draft {
  return {
    id,
    kind: 'comment',
    path,
    side: 'new',
    startLine: 1,
    endLine: 1,
    placement: 'line',
    quote: 'x',
    headSha: 'h1',
    body,
    createdAt: '2026-10-28T10:00:00Z',
  };
}

function review(overrides: Partial<ReviewResponse> = {}): ReviewResponse {
  return {
    viewerIsAuthor: false,
    headSha: 'h1',
    threads: [thread('t1', 'a.ts'), thread('t2', 'b.ts')],
    drafts: [
      comment(1, 'a.ts'),
      comment(2, 'b.ts'),
      { id: 3, kind: 'reply', threadId: 't1', body: 'Re', createdAt: 'x' },
    ],
    ci: { state: 'success', failing: null },
    ...overrides,
  };
}

type Reply = { status: number; body?: unknown };
type Route = (init: RequestInit) => Reply | Promise<Reply>;

/** A fetch mock answering `METHOD url` from `routes`; unknown requests fail the test. */
function serve(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`Unexpected request: ${key}`);
    const { status, body } = await route(init);
    return status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const BASE = '/api/pr/acme/loans/42';

async function loaded() {
  const hook = renderHook(() => useReview('acme/loans', 42));
  await waitFor(() => expect(hook.result.current.state).toBe('ready'));
  return hook;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useReview', () => {
  it('loads the review and filters by path', async () => {
    serve({ [`GET ${BASE}/review`]: () => ({ status: 200, body: review() }) });

    const { result } = renderHook(() => useReview('acme/loans', 42));
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('ready'));

    expect(result.current.headSha).toBe('h1');
    expect(result.current.viewerIsAuthor).toBe(false);
    expect(result.current.ci.state).toBe('success');
    expect(result.current.threads).toHaveLength(2);
    expect(result.current.drafts).toHaveLength(3);
    expect(result.current.threadsFor('a.ts').map((t) => t.id)).toEqual(['t1']);
    expect(result.current.draftsFor('b.ts').map((d) => d.id)).toEqual([2]);
    // Replies are not comments on a path.
    expect(result.current.draftsFor('a.ts').map((d) => d.id)).toEqual([1]);
  });

  it('reports a load error', async () => {
    serve({ [`GET ${BASE}/review`]: () => ({ status: 500, body: { error: 'No GitHub' } }) });

    const { result } = renderHook(() => useReview('acme/loans', 42));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error).toBe('No GitHub');
  });

  it('add, update and remove follow the server', async () => {
    serve({
      [`GET ${BASE}/review`]: () => ({ status: 200, body: review({ drafts: [] }) }),
      [`POST ${BASE}/drafts`]: () => ({ status: 201, body: comment(9, 'a.ts', 'Server text') }),
      [`PATCH ${BASE}/drafts/9`]: () => ({ status: 200, body: comment(9, 'a.ts', 'Edited') }),
      [`DELETE ${BASE}/drafts/9`]: () => ({ status: 204 }),
    });
    const { result } = await loaded();

    await act(() =>
      result.current.add({
        kind: 'comment',
        path: 'a.ts',
        side: 'new',
        startLine: 1,
        endLine: 1,
        body: 'Typed',
      }),
    );
    expect(result.current.drafts).toEqual([comment(9, 'a.ts', 'Server text')]);

    await act(() => result.current.update(9, 'Edited'));
    expect(result.current.draftsFor('a.ts')[0]?.body).toBe('Edited');

    await act(() => result.current.remove(9));
    expect(result.current.drafts).toEqual([]);
  });

  it('a failed add leaves the drafts alone and rejects', async () => {
    serve({
      [`GET ${BASE}/review`]: () => ({ status: 200, body: review() }),
      [`POST ${BASE}/drafts`]: () => ({ status: 400, body: { error: 'Bad draft' } }),
    });
    const { result } = await loaded();

    await act(async () => {
      await expect(
        result.current.add({ kind: 'reply', threadId: 't1', body: 'x' }),
      ).rejects.toThrow('Bad draft');
    });
    expect(result.current.drafts).toHaveLength(3);
  });

  it('submit success returns the url and reloads', async () => {
    let loads = 0;
    const fetchMock = serve({
      [`GET ${BASE}/review`]: () => {
        loads += 1;
        return { status: 200, body: loads === 1 ? review() : review({ drafts: [] }) };
      },
      [`POST ${BASE}/review/submit`]: () => ({ status: 200, body: { url: 'https://gh/r/1' } }),
    });
    const { result } = await loaded();

    let out: { url: string } | null = null;
    await act(async () => {
      out = await result.current.submit('APPROVE', 'LGTM');
    });

    expect(out).toEqual({ url: 'https://gh/r/1' });
    await waitFor(() => expect(result.current.drafts).toEqual([]));
    expect(result.current.submitError).toBeNull();
    const submitCall = fetchMock.mock.calls.find(([url]) => url.endsWith('/review/submit'));
    expect(JSON.parse(submitCall![1].body as string)).toEqual({ event: 'APPROVE', body: 'LGTM' });
  });

  it('submit failure keeps the drafts and exposes the error and failed draft', async () => {
    serve({
      [`GET ${BASE}/review`]: () => ({ status: 200, body: review() }),
      [`POST ${BASE}/review/submit`]: () => ({
        status: 502,
        body: { error: 'Line is gone', failedDraftId: 2 },
      }),
    });
    const { result } = await loaded();

    let out: { url: string } | null = { url: 'unset' };
    await act(async () => {
      out = await result.current.submit('COMMENT', '');
    });

    expect(out).toBeNull();
    expect(result.current.drafts).toHaveLength(3);
    expect(result.current.submitError).toEqual({ message: 'Line is gone', failedDraftId: 2 });
    expect(result.current.submitting).toBe(false);
  });

  it('does not start a second submit while one is in flight', async () => {
    let finish: (r: Reply) => void = () => {};
    const fetchMock = serve({
      [`GET ${BASE}/review`]: () => ({ status: 200, body: review() }),
      [`POST ${BASE}/review/submit`]: () => new Promise<Reply>((resolve) => (finish = resolve)),
    });
    const { result } = await loaded();

    let first: Promise<{ url: string } | null> = Promise.resolve(null);
    act(() => {
      first = result.current.submit('COMMENT', 'a');
    });
    await waitFor(() => expect(result.current.submitting).toBe(true));

    let second: { url: string } | null = { url: 'unset' };
    await act(async () => {
      second = await result.current.submit('COMMENT', 'b');
    });
    expect(second).toBeNull();
    const submits = fetchMock.mock.calls.filter(([url]) => url.endsWith('/review/submit'));
    expect(submits).toHaveLength(1);

    await act(async () => {
      finish({ status: 200, body: { url: 'https://gh/r/2' } });
      expect(await first).toEqual({ url: 'https://gh/r/2' });
    });
    await waitFor(() => expect(result.current.submitting).toBe(false));
  });

  it('resolve marks the thread once the server agrees', async () => {
    const fetchMock = serve({
      [`GET ${BASE}/review`]: () => ({ status: 200, body: review() }),
      [`POST ${BASE}/threads/t2/resolve`]: () => ({ status: 204 }),
    });
    const { result } = await loaded();

    await act(() => result.current.resolve('t2', true));

    expect(result.current.threadsFor('b.ts')[0]?.resolved).toBe(true);
    expect(result.current.threadsFor('a.ts')[0]?.resolved).toBe(false);
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/resolve'));
    expect(JSON.parse(call![1].body as string)).toEqual({ resolved: true });
  });

  it('reload fetches the review again', async () => {
    let loads = 0;
    serve({
      [`GET ${BASE}/review`]: () => {
        loads += 1;
        return {
          status: 200,
          body: review({ threads: loads === 1 ? [] : [thread('t9', 'c.ts')] }),
        };
      },
    });
    const { result } = await loaded();

    await act(() => result.current.reload());

    expect(result.current.threadsFor('c.ts').map((t) => t.id)).toEqual(['t9']);
  });
});
