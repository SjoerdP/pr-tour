import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTour, markSeen } from '../../src/web/api.js';

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
