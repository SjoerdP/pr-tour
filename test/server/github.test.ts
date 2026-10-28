import { describe, expect, it } from 'vitest';
import { CommandError } from '../../src/server/exec.js';
import {
  GitHub,
  InvalidRepoError,
  PrNotFoundError,
  type PrSummary,
} from '../../src/server/github.js';
import type { CiStatus } from '../../src/shared/review.js';
import { fakeRunner } from '../helpers/fake-runner.js';

/** A GraphQL pull request node as `gh api graphql` returns it. */
function prNode(repo: string, number: number, updatedAt: string, extra: object = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    additions: 10,
    deletions: 2,
    isDraft: false,
    updatedAt,
    baseRefOid: 'a'.repeat(40),
    headRefOid: 'b'.repeat(40),
    repository: { nameWithOwner: repo },
    author: { login: 'alice' },
    viewerDidAuthor: false,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...extra,
  };
}

function summary(repo: string, number: number, updatedAt: string): PrSummary {
  return {
    repo,
    number,
    title: `PR ${number}`,
    author: 'alice',
    url: `https://github.com/${repo}/pull/${number}`,
    additions: 10,
    deletions: 2,
    isDraft: false,
    updatedAt,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    viewerIsAuthor: false,
  };
}

/** An inbox row: a summary with its CI status. */
function inboxRow(repo: string, number: number, updatedAt: string, extra: object = {}) {
  return { ...summary(repo, number, updatedAt), ci: NO_CI, ...extra };
}

const NO_CI: CiStatus = { state: 'none', failing: null };

function answering(data: unknown): ReturnType<typeof fakeRunner> {
  return fakeRunner({ stdout: JSON.stringify({ data }), stderr: '', code: 0 });
}

/** The value passed for a `-f`/`-F` field, e.g. `fieldValue(args, 'owner')`. */
function fieldValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

describe('GitHub.inbox', () => {
  it('inbox maps both lists, newest first', async () => {
    const { run, calls } = answering({
      reviewRequested: {
        nodes: [
          prNode('acme/api', 1, '2026-10-01T00:00:00Z'),
          prNode('acme/web', 2, '2026-10-03T00:00:00Z'),
        ],
      },
      mine: {
        nodes: [
          prNode('acme/api', 3, '2026-10-02T00:00:00Z', { isDraft: true, author: { login: 'me' } }),
        ],
      },
    });

    const inbox = await new GitHub(run).inbox();

    expect(inbox).toEqual({
      reviewRequested: [
        inboxRow('acme/web', 2, '2026-10-03T00:00:00Z'),
        inboxRow('acme/api', 1, '2026-10-01T00:00:00Z'),
      ],
      mine: [inboxRow('acme/api', 3, '2026-10-02T00:00:00Z', { isDraft: true, author: 'me' })],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('gh');
    const query = fieldValue(calls[0]?.args ?? [], 'query') ?? '';
    expect(query).toContain('is:pr is:open review-requested:@me');
    expect(query).toContain('is:pr is:open author:@me');
  });

  it('inbox skips non-PR nodes', async () => {
    const { run } = answering({
      reviewRequested: { nodes: [{}, prNode('acme/api', 1, '2026-10-01T00:00:00Z'), {}] },
      mine: { nodes: [{}] },
    });

    const inbox = await new GitHub(run).inbox();

    expect(inbox).toEqual({
      reviewRequested: [inboxRow('acme/api', 1, '2026-10-01T00:00:00Z')],
      mine: [],
    });
  });

  it('inbox shows a deleted author as ghost', async () => {
    const { run } = answering({
      reviewRequested: { nodes: [prNode('acme/api', 1, '2026-10-01T00:00:00Z', { author: null })] },
      mine: { nodes: [] },
    });

    const inbox = await new GitHub(run).inbox();

    expect(inbox.reviewRequested[0]?.author).toBe('ghost');
  });

  it('inbox includes ci and viewerIsAuthor', async () => {
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [{ __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE', detailsUrl: 'u1' }],
      },
    };
    const { run, calls } = answering({
      reviewRequested: { nodes: [] },
      mine: {
        nodes: [
          prNode('acme/api', 3, '2026-10-02T00:00:00Z', {
            viewerDidAuthor: true,
            commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
          }),
        ],
      },
    });

    const inbox = await new GitHub(run).inbox();

    expect(inbox.mine[0]).toMatchObject({
      viewerIsAuthor: true,
      ci: { state: 'failure', failing: { name: 'test', url: 'u1' } },
    });
    const query = fieldValue(calls[0]?.args ?? [], 'query') ?? '';
    expect(query).toContain('viewerDidAuthor');
    expect(query).toContain('statusCheckRollup');
  });
});

describe('GitHub.pr', () => {
  it('pr maps one PR, passing owner, name and number as variables', async () => {
    const { run, calls } = answering({
      repository: { pullRequest: prNode('acme/api', 42, '2026-10-01T00:00:00Z') },
    });

    const pr = await new GitHub(run).pr('acme/api', 42);

    expect(pr).toEqual(summary('acme/api', 42, '2026-10-01T00:00:00Z'));
    const args = calls[0]?.args ?? [];
    expect(fieldValue(args, 'owner')).toBe('acme');
    expect(fieldValue(args, 'name')).toBe('api');
    expect(fieldValue(args, 'number')).toBe('42');
    expect(fieldValue(args, 'query')).not.toContain('acme');
    expect(fieldValue(args, 'query')).toContain('viewerDidAuthor');
  });

  it('pr rejects a repo that is not owner/name', async () => {
    const { run, calls } = answering({});

    const error: unknown = await new GitHub(run).pr('@/etc/passwd', 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidRepoError);
    expect((error as Error).message).toMatch(/owner\/name/);
    expect(calls).toHaveLength(0);
  });

  it('pr throws when the PR does not exist', async () => {
    const { run } = answering({ repository: { pullRequest: null } });

    const error: unknown = await new GitHub(run).pr('acme/api', 999).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrNotFoundError);
    expect((error as Error).message).toContain('acme/api#999');
  });

  it('pr throws PrNotFoundError when gh cannot resolve the repo or PR', async () => {
    const { run } = fakeRunner({
      stdout: '',
      stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/nope'. (repository)",
      code: 1,
    });

    const error: unknown = await new GitHub(run).pr('acme/nope', 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrNotFoundError);
    expect((error as Error).message).toContain('acme/nope#1');
  });
});

describe('GitHub errors', () => {
  it('gh failure throws CommandError with stderr', async () => {
    const { run } = fakeRunner({ stdout: '', stderr: 'gh: not logged in', code: 1 });

    const error: unknown = await new GitHub(run).inbox().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).message).toContain('gh: not logged in');
  });
});
