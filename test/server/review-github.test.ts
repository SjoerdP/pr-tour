import { describe, expect, it, vi } from 'vitest';
import { GraphqlError } from '../../src/server/graphql.js';
import { PrNotFoundError } from '../../src/server/github.js';
import { ReviewGitHub, ReviewSubmitError, ciStatus } from '../../src/server/review-github.js';
import { fileCommentBody, type Draft } from '../../src/shared/review.js';
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

/** The mutation a `gh api graphql` call runs, e.g. `addPullRequestReview`. */
function mutationName(call: RunCall): string {
  const query = fieldValue(call.args, 'query') ?? '';
  return /mutation[^{]*\{\s*(\w+)/.exec(query)?.[1] ?? '';
}

/** The variable flags of a call, without the query: `[['-f', 'body=hi'], ...]`. */
function variables(call: RunCall): string[][] {
  const pairs: string[][] = [];
  for (let i = 2; i < call.args.length; i += 2) {
    const flag = call.args[i] ?? '';
    const value = call.args[i + 1] ?? '';
    if (!value.startsWith('query=')) pairs.push([flag, value]);
  }
  return pairs;
}

const RESULTS: Record<string, unknown> = {
  addPullRequestReview: { addPullRequestReview: { pullRequestReview: { id: 'R_1' } } },
  addPullRequestReviewThread: { addPullRequestReviewThread: { thread: { id: 'T_new' } } },
  addPullRequestReviewThreadReply: {
    addPullRequestReviewThreadReply: { comment: { id: 'C_new' } },
  },
  submitPullRequestReview: {
    submitPullRequestReview: {
      pullRequestReview: { url: 'https://github.com/acme/api/pull/7#r1' },
    },
  },
  deletePullRequestReview: { deletePullRequestReview: { clientMutationId: null } },
  resolveReviewThread: { resolveReviewThread: { thread: { id: 'T1' } } },
  unresolveReviewThread: { unresolveReviewThread: { thread: { id: 'T1' } } },
};

/** A runner that answers each mutation; `fail(call, n)` returning true makes the n-th call fail. */
function githubRunner(fail: (call: RunCall, index: number) => boolean = () => false) {
  let index = 0;
  return fakeRunner((call) => {
    if (fail(call, index++))
      return { stdout: '', stderr: 'gh: Something went wrong\nmore', code: 1 };
    return ok(JSON.stringify({ data: RESULTS[mutationName(call)] }));
  });
}

const HEAD = 'abc123';

function lineDraft(id: number, extra: Partial<Extract<Draft, { kind: 'comment' }>> = {}): Draft {
  return {
    id,
    kind: 'comment',
    path: 'src/a.ts',
    side: 'new',
    startLine: 12,
    endLine: 12,
    placement: 'line',
    quote: 'const a = 1;',
    headSha: HEAD,
    body: `draft body ${id}`,
    createdAt: '2026-10-28T12:00:00Z',
    ...extra,
  };
}

function replyDraft(id: number): Draft {
  return {
    id,
    kind: 'reply',
    threadId: 'T_old',
    body: `reply body ${id}`,
    createdAt: '2026-10-28T12:00:00Z',
  };
}

function submitArgs(drafts: Draft[]) {
  return {
    prId: 'PR_1',
    commitOid: HEAD,
    event: 'REQUEST_CHANGES' as const,
    body: 'Overall body',
    drafts,
  };
}

describe('ReviewGitHub.submitReview', () => {
  it('submits drafts in order then the event', async () => {
    const { run, calls } = githubRunner();
    const drafts = [
      lineDraft(1),
      lineDraft(2, { startLine: 10, endLine: 14 }),
      lineDraft(3, { side: 'old', startLine: 4, endLine: 4 }),
      lineDraft(4, { placement: 'file', startLine: 30, endLine: 31, quote: 'x\ny' }),
      replyDraft(5),
    ];

    const result = await new ReviewGitHub(run).submitReview(submitArgs(drafts));

    expect(result).toEqual({ url: 'https://github.com/acme/api/pull/7#r1' });
    expect(calls.map((c) => [mutationName(c), variables(c)])).toEqual([
      [
        'addPullRequestReview',
        [
          ['-f', 'prId=PR_1'],
          ['-f', `commitOid=${HEAD}`],
        ],
      ],
      [
        'addPullRequestReviewThread',
        [
          ['-f', 'reviewId=R_1'],
          ['-f', 'path=src/a.ts'],
          ['-f', 'body=draft body 1'],
          ['-f', 'subjectType=LINE'],
          ['-F', 'line=12'],
          ['-f', 'side=RIGHT'],
        ],
      ],
      [
        'addPullRequestReviewThread',
        [
          ['-f', 'reviewId=R_1'],
          ['-f', 'path=src/a.ts'],
          ['-f', 'body=draft body 2'],
          ['-f', 'subjectType=LINE'],
          ['-F', 'line=14'],
          ['-f', 'side=RIGHT'],
          ['-F', 'startLine=10'],
          ['-f', 'startSide=RIGHT'],
        ],
      ],
      [
        'addPullRequestReviewThread',
        [
          ['-f', 'reviewId=R_1'],
          ['-f', 'path=src/a.ts'],
          ['-f', 'body=draft body 3'],
          ['-f', 'subjectType=LINE'],
          ['-F', 'line=4'],
          ['-f', 'side=LEFT'],
        ],
      ],
      [
        'addPullRequestReviewThread',
        [
          ['-f', 'reviewId=R_1'],
          ['-f', 'path=src/a.ts'],
          ['-f', `body=${fileCommentBody('src/a.ts', 'new', 30, 31, 'x\ny', 'draft body 4')}`],
          ['-f', 'subjectType=FILE'],
        ],
      ],
      [
        'addPullRequestReviewThreadReply',
        [
          ['-f', 'reviewId=R_1'],
          ['-f', 'threadId=T_old'],
          ['-f', 'body=reply body 5'],
        ],
      ],
      [
        'submitPullRequestReview',
        [
          ['-f', 'reviewId=R_1'],
          ['-f', 'event=REQUEST_CHANGES'],
          ['-f', 'body=Overall body'],
        ],
      ],
    ]);
    expect(
      calls.every((c) => c.cmd === 'gh' && c.args[0] === 'api' && c.args[1] === 'graphql'),
    ).toBe(true);
  });

  it('uses commitOID from args', async () => {
    const { run, calls } = githubRunner();

    await new ReviewGitHub(run).submitReview({ ...submitArgs([]), commitOid: 'fff999' });

    expect(fieldValue(calls[0]?.args ?? [], 'commitOid')).toBe('fff999');
    expect(fieldValue(calls[0]?.args ?? [], 'query')).toContain('commitOID: $commitOid');
  });

  it('older-version line draft is sent as a FILE comment with its quote', async () => {
    const { run, calls } = githubRunner();
    const draft = lineDraft(1, { headSha: 'old999', startLine: 3, endLine: 5, quote: 'a\nb\nc' });

    await new ReviewGitHub(run).submitReview(submitArgs([draft]));

    const thread = calls[1];
    expect(thread && mutationName(thread)).toBe('addPullRequestReviewThread');
    expect(thread && variables(thread)).toEqual([
      ['-f', 'reviewId=R_1'],
      ['-f', 'path=src/a.ts'],
      ['-f', `body=${fileCommentBody('src/a.ts', 'new', 3, 5, 'a\nb\nc', 'draft body 1')}`],
      ['-f', 'subjectType=FILE'],
    ]);
  });

  it('failure on the 2nd draft deletes the pending review and reports that draft', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run, calls } = githubRunner((_call, index) => index === 2);
    const drafts = [lineDraft(1), lineDraft(2, { path: 'src/b.ts' }), replyDraft(3)];

    const error: unknown = await new ReviewGitHub(run)
      .submitReview(submitArgs(drafts))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReviewSubmitError);
    expect((error as ReviewSubmitError).failedDraftId).toBe(2);
    expect((error as Error).message).toBe(
      "Couldn't add your comment on src/b.ts: gh failed: gh: Something went wrong",
    );
    expect(calls.map(mutationName)).toEqual([
      'addPullRequestReview',
      'addPullRequestReviewThread',
      'addPullRequestReviewThread',
      'deletePullRequestReview',
    ]);
    expect(variables(calls[3] as RunCall)).toEqual([['-f', 'reviewId=R_1']]);
    log.mockRestore();
  });

  it('failure on a reply reports that reply', async () => {
    const { run } = githubRunner(
      (call) => mutationName(call) === 'addPullRequestReviewThreadReply',
    );

    const error: unknown = await new ReviewGitHub(run)
      .submitReview(submitArgs([replyDraft(7)]))
      .catch((e: unknown) => e);

    expect((error as ReviewSubmitError).failedDraftId).toBe(7);
    expect((error as Error).message).toBe(
      "Couldn't add your reply: gh failed: gh: Something went wrong",
    );
  });

  it('failure on submit deletes the pending review', async () => {
    const { run, calls } = githubRunner((call) => mutationName(call) === 'submitPullRequestReview');

    const error: unknown = await new ReviewGitHub(run)
      .submitReview(submitArgs([lineDraft(1)]))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReviewSubmitError);
    expect((error as ReviewSubmitError).failedDraftId).toBeNull();
    expect((error as Error).message).toBe(
      "Couldn't submit your review: gh failed: gh: Something went wrong",
    );
    expect(calls.map(mutationName).at(-1)).toBe('deletePullRequestReview');
  });

  it('a failing delete is logged and the original error still thrown', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = githubRunner((call) =>
      ['submitPullRequestReview', 'deletePullRequestReview'].includes(mutationName(call)),
    );

    const error: unknown = await new ReviewGitHub(run)
      .submitReview(submitArgs([]))
      .catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/^Couldn't submit your review/);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('failure to start the review deletes nothing', async () => {
    const { run, calls } = githubRunner((call) => mutationName(call) === 'addPullRequestReview');

    const error: unknown = await new ReviewGitHub(run)
      .submitReview(submitArgs([lineDraft(1)]))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReviewSubmitError);
    expect((error as Error).message).toBe(
      "Couldn't start your review: gh failed: gh: Something went wrong",
    );
    expect(calls.map(mutationName)).toEqual(['addPullRequestReview']);
  });

  it('a GraphQL error with a null result fails the step', async () => {
    const { run, calls } = fakeRunner((call) => {
      if (mutationName(call) === 'addPullRequestReviewThread') {
        return ok(
          JSON.stringify({
            data: { addPullRequestReviewThread: null },
            errors: [{ message: 'line must be part of the diff' }],
          }),
        );
      }
      return ok(JSON.stringify({ data: RESULTS[mutationName(call)] }));
    });

    const error: unknown = await new ReviewGitHub(run)
      .submitReview(submitArgs([lineDraft(1)]))
      .catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      "Couldn't add your comment on src/a.ts: line must be part of the diff",
    );
    expect(calls.map(mutationName).at(-1)).toBe('deletePullRequestReview');
  });

  it('body text never interpolated into query', async () => {
    const { run, calls } = githubRunner();
    const drafts = [
      lineDraft(1, { body: 'SECRET_ONE "quoted" $var' }),
      lineDraft(2, { placement: 'file', body: 'SECRET_TWO' }),
      { ...replyDraft(3), body: 'SECRET_THREE' },
    ];

    await new ReviewGitHub(run).submitReview({ ...submitArgs(drafts), body: 'SECRET_FOUR' });

    const queries = calls.map((c) => fieldValue(c.args, 'query') ?? '');
    expect(queries).toHaveLength(5);
    for (const q of queries) expect(q).not.toMatch(/SECRET|src\/a\.ts|PR_1|R_1|T_old/);
  });
});

describe('ReviewGitHub.setResolved', () => {
  it('setResolved true/false uses the right mutation', async () => {
    const { run, calls } = githubRunner();
    const github = new ReviewGitHub(run);

    await github.setResolved('T1', true);
    await github.setResolved('T1', false);

    expect(calls.map((c) => [mutationName(c), variables(c)])).toEqual([
      ['resolveReviewThread', [['-f', 'threadId=T1']]],
      ['unresolveReviewThread', [['-f', 'threadId=T1']]],
    ]);
  });
});
