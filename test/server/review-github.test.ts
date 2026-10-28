import { describe, expect, it } from 'vitest';
import { GraphqlError } from '../../src/server/graphql.js';
import { PrNotFoundError } from '../../src/server/github.js';
import { ReviewGitHub, ciStatus } from '../../src/server/review-github.js';
import { fakeRunner, ok, type RunCall } from '../helpers/fake-runner.js';

/** The value passed for a `-f`/`-F` field, e.g. `fieldValue(args, 'owner')`. */
function fieldValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function comment(id: string, extra: object = {}) {
  return {
    id,
    author: { login: 'bob' },
    body: `body ${id}`,
    createdAt: '2026-10-28T12:00:00Z',
    url: `https://github.com/acme/api/pull/7#discussion_${id}`,
    ...extra,
  };
}

function page<T>(nodes: T[], endCursor: string | null = null) {
  return { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes };
}

function threadNode(id: string, extra: object = {}) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 12,
    startLine: null,
    diffSide: 'RIGHT',
    subjectType: 'LINE',
    comments: page([comment(`${id}-c1`)]),
    ...extra,
  };
}

function prData(
  extra: { threads?: unknown; rollup?: unknown; viewerDidAuthor?: boolean; id?: string } = {},
) {
  return {
    repository: {
      pullRequest: {
        id: extra.id ?? 'PR_1',
        viewerDidAuthor: extra.viewerDidAuthor ?? false,
        reviewThreads: extra.threads ?? page([]),
        commits: { nodes: [{ commit: { statusCheckRollup: extra.rollup ?? null } }] },
      },
    },
  };
}

function answering(data: unknown) {
  return fakeRunner(ok(JSON.stringify({ data })));
}

describe('ReviewGitHub.reviewState threads', () => {
  it('maps line, range, old-side and file-level threads', async () => {
    const { run, calls } = answering(
      prData({
        threads: page([
          threadNode('T1'),
          threadNode('T2', { line: 20, startLine: 15 }),
          threadNode('T3', { diffSide: 'LEFT', line: 4 }),
          threadNode('T4', { subjectType: 'FILE', line: null, diffSide: 'RIGHT' }),
          threadNode('T5', { line: null }),
        ]),
      }),
    );

    const state = await new ReviewGitHub(run).reviewState('acme/api', 7);

    expect(state.threads.map((t) => [t.id, t.side, t.line, t.startLine])).toEqual([
      ['T1', 'new', 12, null],
      ['T2', 'new', 20, 15],
      ['T3', 'old', 4, null],
      ['T4', null, null, null],
      ['T5', null, null, null],
    ]);
    expect(state.threads[0]).toEqual({
      id: 'T1',
      path: 'src/a.ts',
      side: 'new',
      line: 12,
      startLine: null,
      outdated: false,
      resolved: false,
      comments: [
        {
          id: 'T1-c1',
          author: 'bob',
          body: 'body T1-c1',
          createdAt: '2026-10-28T12:00:00Z',
          url: 'https://github.com/acme/api/pull/7#discussion_T1-c1',
        },
      ],
    });
    const args = calls[0]?.args ?? [];
    expect(fieldValue(args, 'owner')).toBe('acme');
    expect(fieldValue(args, 'name')).toBe('api');
    expect(fieldValue(args, 'number')).toBe('7');
    expect(fieldValue(args, 'query')).not.toContain('acme');
  });

  it('outdated and resolved flags', async () => {
    const { run } = answering(
      prData({ threads: page([threadNode('T1', { isOutdated: true, isResolved: true })]) }),
    );

    const state = await new ReviewGitHub(run).reviewState('acme/api', 7);

    expect(state.threads[0]).toMatchObject({ outdated: true, resolved: true });
  });

  it('ghost author', async () => {
    const { run } = answering(
      prData({
        threads: page([threadNode('T1', { comments: page([comment('c1', { author: null })]) })]),
      }),
    );

    const state = await new ReviewGitHub(run).reviewState('acme/api', 7);

    expect(state.threads[0]?.comments[0]?.author).toBe('ghost');
  });

  it('follows thread pagination (2 pages)', async () => {
    const { run, calls } = fakeRunner((call: RunCall) => {
      const cursor = fieldValue(call.args, 'cursor');
      const threads =
        cursor === undefined ? page([threadNode('T1')], 'CUR1') : page([threadNode('T2')]);
      return ok(JSON.stringify({ data: prData({ threads }) }));
    });

    const state = await new ReviewGitHub(run).reviewState('acme/api', 7);

    expect(state.threads.map((t) => t.id)).toEqual(['T1', 'T2']);
    expect(calls).toHaveLength(2);
    expect(fieldValue(calls[1]?.args ?? [], 'cursor')).toBe('CUR1');
  });

  it('follows comment pagination inside a thread', async () => {
    const { run, calls } = fakeRunner((call: RunCall) => {
      const id = fieldValue(call.args, 'id');
      if (id === undefined) {
        const t1 = threadNode('T1', { comments: page([comment('c1')], 'C1') });
        return ok(JSON.stringify({ data: prData({ threads: page([t1]) }) }));
      }
      const cursor = fieldValue(call.args, 'cursor');
      const comments = cursor === 'C1' ? page([comment('c2')], 'C2') : page([comment('c3')]);
      return ok(JSON.stringify({ data: { node: { comments } } }));
    });

    const state = await new ReviewGitHub(run).reviewState('acme/api', 7);

    expect(state.threads[0]?.comments.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(calls).toHaveLength(3);
    expect(fieldValue(calls[1]?.args ?? [], 'id')).toBe('T1');
    expect(fieldValue(calls[1]?.args ?? [], 'cursor')).toBe('C1');
    expect(fieldValue(calls[2]?.args ?? [], 'cursor')).toBe('C2');
    expect(fieldValue(calls[1]?.args ?? [], 'query')).toContain('PullRequestReviewThread');
  });

  it('viewerIsAuthor and prId', async () => {
    const { run } = answering(prData({ viewerDidAuthor: true, id: 'PR_kw' }));

    const state = await new ReviewGitHub(run).reviewState('acme/api', 7);

    expect(state.viewerIsAuthor).toBe(true);
    expect(state.prId).toBe('PR_kw');
  });

  it('PrNotFoundError when the PR is missing', async () => {
    const { run } = answering({ repository: { pullRequest: null } });

    const error: unknown = await new ReviewGitHub(run)
      .reviewState('acme/api', 999)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrNotFoundError);
  });

  it('GraphqlError on errors without data', async () => {
    const { run } = fakeRunner(
      ok(JSON.stringify({ errors: [{ message: 'Something broke' }, { message: 'second' }] })),
    );

    const error: unknown = await new ReviewGitHub(run)
      .reviewState('acme/api', 7)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphqlError);
    expect((error as Error).message).toBe('Something broke');
  });
});

describe('ci status', () => {
  it('ci success', async () => {
    const { run } = answering(prData({ rollup: { state: 'SUCCESS', contexts: { nodes: [] } } }));

    const state = await new ReviewGitHub(run).reviewState('acme/api', 7);

    expect(state.ci).toEqual({ state: 'success', failing: null });
  });

  it('ci failure with failing link from a check run', () => {
    expect(
      ciStatus({
        state: 'FAILURE',
        contexts: {
          nodes: [
            { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS', detailsUrl: 'u0' },
            { __typename: 'CheckRun', name: 'test', conclusion: 'TIMED_OUT', detailsUrl: 'u1' },
            { __typename: 'CheckRun', name: 'e2e', conclusion: 'FAILURE', detailsUrl: 'u2' },
          ],
        },
      }),
    ).toEqual({ state: 'failure', failing: { name: 'test', url: 'u1' } });
  });

  it('ci failure with failing link from a status context', () => {
    expect(
      ciStatus({
        state: 'ERROR',
        contexts: {
          nodes: [
            { __typename: 'StatusContext', context: 'ci/ok', state: 'SUCCESS', targetUrl: 'u0' },
            { __typename: 'StatusContext', context: 'ci/build', state: 'ERROR', targetUrl: 'u1' },
          ],
        },
      }),
    ).toEqual({ state: 'failure', failing: { name: 'ci/build', url: 'u1' } });
  });

  it('ci pending', () => {
    expect(ciStatus({ state: 'PENDING', contexts: { nodes: [] } })).toEqual({
      state: 'pending',
      failing: null,
    });
    expect(ciStatus({ state: 'EXPECTED', contexts: { nodes: [] } }).state).toBe('pending');
  });

  it('ci none without a rollup', () => {
    expect(ciStatus(null)).toEqual({ state: 'none', failing: null });
  });
});
