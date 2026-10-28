import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp, type AppDeps } from '../../src/server/app.js';
import { TourBuildError, finishTour, type TourBuilder } from '../../src/server/build.js';
import { parseDiff } from '../../src/server/diff.js';
import { CommandError } from '../../src/server/exec.js';
import { PrNotFoundError, type GitHub, type PrSummary } from '../../src/server/github.js';
import { Jobs } from '../../src/server/jobs.js';
import type { RepoManager } from '../../src/server/repo.js';
import { Store, StoreError } from '../../src/server/store.js';
import type { InboxResponse, Job, PrResponse } from '../../src/shared/api.js';
import type { FileDiff } from '../../src/shared/diff.js';
import type { Tour } from '../../src/shared/tour.js';

const PORT = 4317;
const HOST = `localhost:${PORT}`;
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const NEWER_HEAD = 'c'.repeat(40);

// modified.diff: greet.js deletes old 2-3 and adds new 2-4.
const DIFF = readFileSync(new URL('../fixtures/modified.diff', import.meta.url), 'utf8');

function summary(repo: string, number: number, extra: Partial<PrSummary> = {}): PrSummary {
  return {
    repo,
    number,
    title: `PR ${number}`,
    author: 'alice',
    url: `https://github.com/${repo}/pull/${number}`,
    additions: 3,
    deletions: 2,
    isDraft: false,
    updatedAt: '2026-10-28T12:00:00Z',
    baseSha: BASE,
    headSha: HEAD,
    ...extra,
  };
}

/** A checked tour of modified.diff for `acme/greet#7` at `headSha`. */
function greetTour(headSha = HEAD): Tour {
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
          items: [
            {
              file: 'greet.js',
              title: 'Rename',
              homes: [
                { file: 'greet.js', side: 'old', start: 2, end: 3 },
                { file: 'greet.js', side: 'new', start: 2, end: 4 },
              ],
            },
          ],
        },
      ],
    },
    {
      repo: 'acme/greet',
      pr: 7,
      baseSha: BASE,
      headSha,
      source: 'inferred',
      createdAt: '2026-10-28T12:00:00.000Z',
    },
    parseDiff(DIFF),
  );
}

type Fakes = {
  github: { inbox: Mock<GitHub['inbox']>; pr: Mock<GitHub['pr']> };
  repos: { fileAt: Mock<RepoManager['fileAt']>; diffText: Mock<RepoManager['diffText']> };
  builder: { build: Mock<TourBuilder['build']> };
  store: Store;
  jobs: Jobs;
};

let fakes: Fakes;
let app: ReturnType<typeof createApp>;

function makeApp(extra: Partial<AppDeps> = {}) {
  return createApp({ ...fakes, port: PORT, ...extra });
}

beforeEach(() => {
  fakes = {
    github: {
      inbox: vi.fn<GitHub['inbox']>().mockResolvedValue({ reviewRequested: [], mine: [] }),
      pr: vi.fn<GitHub['pr']>().mockResolvedValue(summary('acme/greet', 7)),
    },
    repos: {
      fileAt: vi.fn<RepoManager['fileAt']>().mockResolvedValue('file text\n'),
      diffText: vi.fn<RepoManager['diffText']>().mockResolvedValue(DIFF),
    },
    builder: { build: vi.fn<TourBuilder['build']>().mockResolvedValue(greetTour()) },
    store: new Store(':memory:'),
    jobs: new Jobs(),
  };
  app = makeApp();
});

afterEach(() => {
  fakes.store.close();
  vi.restoreAllMocks();
});

/** A request as the web app sends it: right Host, and the X-PR-Tour header on writes. */
function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Host: HOST };
  if (method !== 'GET') headers['X-PR-Tour'] = '1';
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Let the build job's promise settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Silence and capture the server's error log for a test that expects one. */
function captureErrorLog() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('guard', () => {
  it('health ok', async () => {
    const res = await api('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('127.0.0.1 with the port is accepted', async () => {
    const res = await app.request('/api/health', { headers: { Host: `127.0.0.1:${PORT}` } });
    expect(res.status).toBe(200);
  });

  it('bad Host is rejected', async () => {
    const res = await app.request('/api/health', { headers: { Host: `evil.example:${PORT}` } });
    expect(res.status).toBe(403);
  });

  it.each([
    'localhost',
    `localhost:${PORT + 1}`,
    `localhost:${PORT}.evil.example`,
    `LOCALHOST:${PORT}`,
    `localhost.:${PORT}`,
  ])('Host %s (no port, other port, rebinding name, other spelling) is rejected', async (host) => {
    const res = await app.request('/api/health', { headers: { Host: host } });
    expect(res.status).toBe(403);
  });

  it('a write to 127.0.0.1 with the header is accepted', async () => {
    fakes.store.saveTour(greetTour());

    const res = await app.request('/api/pr/acme/greet/7/seen', {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        'X-PR-Tour': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ homeId: 'o1.1', contentHash: 'd'.repeat(40) }),
    });

    expect(res.status).toBe(204);
  });

  it('a CORS preflight is refused and allows nothing', async () => {
    const res = await app.request('/api/pr/acme/greet/7/tour', {
      method: 'OPTIONS',
      headers: {
        Host: HOST,
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-pr-tour',
      },
    });

    expect(res.status).toBe(403);
    const allow = [...res.headers.keys()].filter((h) => h.startsWith('access-control-allow-'));
    expect(allow).toEqual([]);
  });

  it.each([
    ['an API response', HOST],
    ['a refused request', `evil.example:${PORT}`],
  ])('%s cannot be framed', async (_, host) => {
    const res = await app.request('/api/health', { headers: { Host: host } });

    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('request without a Host is rejected', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(403);
  });

  it('POST without X-PR-Tour header is rejected', async () => {
    const res = await app.request('/api/pr/acme/greet/7/tour', {
      method: 'POST',
      headers: { Host: HOST },
    });
    expect(res.status).toBe(403);
    expect(fakes.builder.build).not.toHaveBeenCalled();
  });

  it('POST with X-PR-Tour other than 1 is rejected', async () => {
    const res = await app.request('/api/pr/acme/greet/7/tour', {
      method: 'POST',
      headers: { Host: HOST, 'X-PR-Tour': 'yes' },
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/inbox', () => {
  it('inbox includes tour status and seen count', async () => {
    fakes.github.inbox.mockResolvedValue({
      reviewRequested: [summary('acme/greet', 7)],
      mine: [summary('acme/other', 3)],
    });
    fakes.store.saveTour(greetTour());
    fakes.store.markSeen('acme/greet', 7, 'o1.1', 'hash');

    const body = await json<InboxResponse>(await api('/api/inbox'));

    expect(body.reviewRequested).toEqual([
      {
        ...summary('acme/greet', 7),
        tour: { exists: true, source: 'inferred', headSha: HEAD, homes: 1, flows: 0 },
        seenCount: 1,
      },
    ]);
    expect(body.mine).toEqual([
      { ...summary('acme/other', 3), tour: { exists: false }, seenCount: 0 },
    ]);
  });

  it('inbox shows a corrupt stored tour as missing instead of failing', async () => {
    const log = captureErrorLog();
    fakes.github.inbox.mockResolvedValue({
      reviewRequested: [summary('acme/greet', 7), summary('acme/other', 3)],
      mine: [],
    });
    fakes.store.saveTour(greetTour());
    const real = fakes.store.tourStatus.bind(fakes.store);
    vi.spyOn(fakes.store, 'tourStatus').mockImplementation((repo, pr) => {
      if (pr === 3) throw new StoreError('Stored tour for acme/other#3 is invalid');
      return real(repo, pr);
    });

    const res = await api('/api/inbox');

    expect(res.status).toBe(200);
    const body = await json<InboxResponse>(res);
    expect(body.reviewRequested.map((pr) => pr.tour.exists)).toEqual([true, false]);
    expect(log).toHaveBeenCalled();
  });

  it('inbox counts a corrupt stored tour as 0 seen instead of failing', async () => {
    const log = captureErrorLog();
    fakes.github.inbox.mockResolvedValue({ reviewRequested: [summary('acme/other', 3)], mine: [] });
    vi.spyOn(fakes.store, 'getTour').mockImplementation(() => {
      throw new StoreError('Stored tour for acme/other#3 is invalid');
    });

    const res = await api('/api/inbox');

    expect(res.status).toBe(200);
    const body = await json<InboxResponse>(res);
    expect(body.reviewRequested[0]).toMatchObject({ tour: { exists: false }, seenCount: 0 });
    expect(log).toHaveBeenCalled();
  });

  it('gh failure is 502 with a short message, not the command', async () => {
    const log = captureErrorLog();
    fakes.github.inbox.mockRejectedValue(
      new CommandError('gh', ['api', 'graphql', '-f', 'query=query { search ... }'], {
        stdout: '',
        stderr: 'gh: To get started with GitHub CLI, please run:  gh auth login\nmore help',
        code: 4,
      }),
    );

    const res = await api('/api/inbox');

    expect(res.status).toBe(502);
    const { error } = await json<{ error: string }>(res);
    expect(error).toContain('gh auth login');
    expect(error).not.toContain('query');
    expect(error).not.toContain('more help');
    expect(log).toHaveBeenCalled();
  });

  it('unexpected error is 500 with a generic message', async () => {
    captureErrorLog();
    fakes.github.inbox.mockRejectedValue(new TypeError('cannot read x of undefined'));

    const res = await api('/api/inbox');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error; see the pr-tour server log.' });
  });
});

describe('GET /api/pr/:owner/:name/:pr', () => {
  it('pr reports outdated when head moved', async () => {
    const tour = greetTour(HEAD);
    fakes.store.saveTour(tour);
    fakes.github.pr.mockResolvedValue(summary('acme/greet', 7, { headSha: NEWER_HEAD }));

    const body = await json<PrResponse>(await api('/api/pr/acme/greet/7'));

    expect(body.outdated).toBe(true);
    expect(body.tour).toEqual(tour);
    expect(fakes.github.pr).toHaveBeenCalledWith('acme/greet', 7);
  });

  it('pr is not outdated when the tour is at the head', async () => {
    fakes.store.saveTour(greetTour(HEAD));
    fakes.store.markSeen('acme/greet', 7, 'o1.1', 'h1');

    const body = await json<PrResponse>(await api('/api/pr/acme/greet/7'));

    expect(body).toMatchObject({ outdated: false, seen: { 'o1.1': 'h1' }, job: null });
  });

  it('pr finds the tour whatever the case of owner and name', async () => {
    fakes.store.saveTour(greetTour());

    const body = await json<PrResponse>(await api('/api/pr/Acme/GREET/7'));

    expect(body.tour?.headSha).toBe(HEAD);
    expect(fakes.github.pr).toHaveBeenCalledWith('acme/greet', 7);
  });

  it('pr without a tour has tour null and is not outdated', async () => {
    const body = await json<PrResponse>(await api('/api/pr/acme/greet/7'));

    expect(body).toEqual({
      pr: summary('acme/greet', 7),
      tour: null,
      seen: {},
      outdated: false,
      job: null,
    });
  });

  it('pr with a corrupt stored tour has tour null', async () => {
    captureErrorLog();
    vi.spyOn(fakes.store, 'getTour').mockImplementation(() => {
      throw new StoreError('Stored tour for acme/greet#7 is invalid');
    });

    const res = await api('/api/pr/acme/greet/7');

    expect(res.status).toBe(200);
    expect((await json<PrResponse>(res)).tour).toBeNull();
  });

  it('unknown PR is 404', async () => {
    fakes.github.pr.mockRejectedValue(new PrNotFoundError('acme/greet', 999));

    const res = await api('/api/pr/acme/greet/999');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'pull request acme/greet#999 not found' });
  });

  it.each([
    ['owner of dots', '/api/pr/.../greet/7'],
    ['owner with an encoded slash', '/api/pr/ac%2Fme/greet/7'],
    ['owner with a space', '/api/pr/ac%20me/greet/7'],
    ['name with an encoded ..', '/api/pr/acme/%2E%2E%2Fx/7'],
    ['pr not a number', '/api/pr/acme/greet/abc'],
    ['pr zero', '/api/pr/acme/greet/0'],
    ['pr with a sign', '/api/pr/acme/greet/-7'],
    ['pr over 32 bits', '/api/pr/acme/greet/2147483648'],
  ])('bad params (%s) are 400', async (_, path) => {
    const res = await api(path);

    expect(res.status).toBe(400);
    expect(fakes.github.pr).not.toHaveBeenCalled();
  });
});

describe('POST /api/pr/:owner/:name/:pr/tour', () => {
  it('POST tour starts one job', async () => {
    fakes.builder.build.mockReturnValue(new Promise<Tour>(() => {}));

    const first = await api('/api/pr/acme/greet/7/tour', { method: 'POST' });
    const second = await api('/api/pr/acme/greet/7/tour', { method: 'POST' });

    expect(first.status).toBe(202);
    expect(await json<{ job: Job }>(first)).toEqual({ job: { state: 'running', log: [] } });
    expect(second.status).toBe(202);
    expect(fakes.builder.build).toHaveBeenCalledTimes(1);
    expect(fakes.builder.build).toHaveBeenCalledWith('acme/greet', 7, expect.any(Function));
  });

  it('the same PR spelled in another case is the same job', async () => {
    fakes.builder.build.mockReturnValue(new Promise<Tour>(() => {}));

    await api('/api/pr/Acme/Greet/7/tour', { method: 'POST' });
    await api('/api/pr/acme/greet/7/tour', { method: 'POST' });

    expect(fakes.builder.build).toHaveBeenCalledTimes(1);
    expect(fakes.builder.build).toHaveBeenCalledWith('acme/greet', 7, expect.any(Function));
  });

  it('jobs of different PRs run side by side', async () => {
    fakes.builder.build.mockReturnValue(new Promise<Tour>(() => {}));

    await api('/api/pr/acme/greet/7/tour', { method: 'POST' });
    await api('/api/pr/acme/greet/8/tour', { method: 'POST' });

    expect(fakes.builder.build).toHaveBeenCalledTimes(2);
  });

  it('build log lines show on the job', async () => {
    fakes.builder.build.mockImplementation((_repo, _pr, onLog) => {
      onLog?.('Fetching acme/greet#7');
      return new Promise<Tour>(() => {});
    });

    await api('/api/pr/acme/greet/7/tour', { method: 'POST' });
    const body = await json<PrResponse>(await api('/api/pr/acme/greet/7'));

    expect(body.job).toEqual({ state: 'running', log: ['Fetching acme/greet#7'] });
  });

  it('failed job shows error', async () => {
    captureErrorLog();
    fakes.builder.build.mockRejectedValue(new TourBuildError('bad json', 'raw output excerpt'));

    await api('/api/pr/acme/greet/7/tour', { method: 'POST' });
    await flush();
    const body = await json<PrResponse>(await api('/api/pr/acme/greet/7'));

    expect(body.job?.state).toBe('failed');
    expect(body.job?.error).toContain('bad json');
    expect(body.job?.error).not.toContain('raw output excerpt');
  });

  it('failed job from a git failure shows a short message', async () => {
    captureErrorLog();
    fakes.builder.build.mockRejectedValue(
      new CommandError('git', ['-c', 'core.quotepath=off', 'fetch', 'origin'], {
        stdout: '',
        stderr: 'fatal: could not read from remote repository\n\nPlease make sure...',
        code: 128,
      }),
    );

    await api('/api/pr/acme/greet/7/tour', { method: 'POST' });
    await flush();
    const body = await json<PrResponse>(await api('/api/pr/acme/greet/7'));

    expect(body.job?.error).toBe('git failed: fatal: could not read from remote repository');
  });
});

describe('GET /api/pr/:owner/:name/:pr/file', () => {
  beforeEach(() => fakes.store.saveTour(greetTour()));

  it.each([
    ['head', HEAD],
    ['base', BASE],
  ])('file at the tour %s sha', async (_, sha) => {
    const res = await api(`/api/pr/acme/greet/7/file?sha=${sha}&path=src/greet.js`);

    expect(await res.json()).toEqual({ text: 'file text\n' });
    expect(fakes.repos.fileAt).toHaveBeenCalledWith('acme/greet', sha, 'src/greet.js');
  });

  it('missing file is text null', async () => {
    fakes.repos.fileAt.mockResolvedValue(null);

    const res = await api(`/api/pr/acme/greet/7/file?sha=${HEAD}&path=gone.js`);

    expect(await res.json()).toEqual({ text: null });
  });

  it('a sha that is not the tour base or head is 400', async () => {
    const res = await api(`/api/pr/acme/greet/7/file?sha=${NEWER_HEAD}&path=greet.js`);

    expect(res.status).toBe(400);
    expect(fakes.repos.fileAt).not.toHaveBeenCalled();
  });

  it.each(['../secret', 'src/../../secret', '/etc/passwd', '', 'src//a.js'])(
    'path %j is 400',
    async (path) => {
      const res = await api(
        `/api/pr/acme/greet/7/file?sha=${HEAD}&path=${encodeURIComponent(path)}`,
      );

      expect(res.status).toBe(400);
      expect(fakes.repos.fileAt).not.toHaveBeenCalled();
    },
  );

  it('file of a PR without a tour is 404', async () => {
    const res = await api(`/api/pr/acme/greet/8/file?sha=${HEAD}&path=greet.js`);

    expect(res.status).toBe(404);
  });
});

describe('GET /api/pr/:owner/:name/:pr/diff', () => {
  beforeEach(() => fakes.store.saveTour(greetTour()));

  it('diff of one file at the tour base and head', async () => {
    const res = await api('/api/pr/acme/greet/7/diff?file=greet.js');

    const file = await json<FileDiff>(res);
    expect(file).toEqual(parseDiff(DIFF).find((f) => f.path === 'greet.js'));
    expect(fakes.repos.diffText).toHaveBeenCalledWith('acme/greet', BASE, HEAD);
  });

  it('a file not in the diff is 404', async () => {
    const res = await api('/api/pr/acme/greet/7/diff?file=other.js');

    expect(res.status).toBe(404);
  });

  it('missing file param is 400', async () => {
    const res = await api('/api/pr/acme/greet/7/diff');

    expect(res.status).toBe(400);
  });
});

describe('POST /api/pr/:owner/:name/:pr/seen', () => {
  beforeEach(() => fakes.store.saveTour(greetTour()));

  it('seen stores the mark', async () => {
    const hash = 'd'.repeat(40);

    const res = await api('/api/pr/acme/greet/7/seen', {
      method: 'POST',
      body: { homeId: 'o1.1', contentHash: hash },
    });

    expect(res.status).toBe(204);
    expect(fakes.store.seen('acme/greet', 7)).toEqual({ 'o1.1': hash });
  });

  it('seen of a home that is not in the tour is 400', async () => {
    const res = await api('/api/pr/acme/greet/7/seen', {
      method: 'POST',
      body: { homeId: 'F9.S9', contentHash: 'd'.repeat(40) },
    });

    expect(res.status).toBe(400);
    expect(fakes.store.seenCount('acme/greet', 7)).toBe(0);
  });

  it('seen of a PR without a tour is 404', async () => {
    const res = await api('/api/pr/acme/greet/8/seen', {
      method: 'POST',
      body: { homeId: 'o1.1', contentHash: 'd'.repeat(40) },
    });

    expect(res.status).toBe(404);
    expect(fakes.store.seenCount('acme/greet', 8)).toBe(0);
  });

  it.each([
    ['missing contentHash', { homeId: 'o1.1' }],
    ['empty homeId', { homeId: '', contentHash: 'd'.repeat(40) }],
    ['contentHash not a sha1', { homeId: 'o1.1', contentHash: 'nope' }],
  ])('seen with %s is 400', async (_, body) => {
    const res = await api('/api/pr/acme/greet/7/seen', { method: 'POST', body });

    expect(res.status).toBe(400);
    expect(fakes.store.seenCount('acme/greet', 7)).toBe(0);
  });

  it('seen with a body that is not JSON is 400', async () => {
    const res = await app.request('/api/pr/acme/greet/7/seen', {
      method: 'POST',
      headers: { Host: HOST, 'X-PR-Tour': '1', 'Content-Type': 'application/json' },
      body: '{not json',
    });

    expect(res.status).toBe(400);
  });
});

describe('web app', () => {
  let webDir: string;

  beforeEach(() => {
    webDir = mkdtempSync(join(tmpdir(), 'pr-tour-web-'));
    mkdirSync(join(webDir, 'assets'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>pr-tour</title>');
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log("app")');
    app = makeApp({ webDir });
  });

  afterEach(() => rmSync(webDir, { recursive: true, force: true }));

  it('serves built files', async () => {
    const res = await api('/assets/app.js');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("app")');
  });

  it('serves index.html for app routes', async () => {
    const res = await api('/pr/acme/greet/7');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>pr-tour</title>');
  });

  it('unknown /api route is a JSON 404, not the app', async () => {
    const res = await api('/api/nope');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('the app cannot be framed', async () => {
    const res = await api('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('web files are guarded too', async () => {
    const res = await app.request('/', { headers: { Host: `evil.example:${PORT}` } });

    expect(res.status).toBe(403);
  });
});
