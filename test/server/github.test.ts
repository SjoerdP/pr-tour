import { describe, expect, it } from 'vitest';
import { CommandError } from '../../src/server/exec.js';
import { GitHub, type PrSummary } from '../../src/server/github.js';
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
  };
}

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
        summary('acme/web', 2, '2026-10-03T00:00:00Z'),
        summary('acme/api', 1, '2026-10-01T00:00:00Z'),
      ],
      mine: [{ ...summary('acme/api', 3, '2026-10-02T00:00:00Z'), isDraft: true, author: 'me' }],
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
      reviewRequested: [summary('acme/api', 1, '2026-10-01T00:00:00Z')],
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
  });

  it('pr rejects a repo that is not owner/name', async () => {
    const { run, calls } = answering({});

    await expect(new GitHub(run).pr('@/etc/passwd', 1)).rejects.toThrow(/owner\/name/);
    expect(calls).toHaveLength(0);
  });

  it('pr throws when the PR does not exist', async () => {
    const { run } = answering({ repository: { pullRequest: null } });

    await expect(new GitHub(run).pr('acme/api', 999)).rejects.toThrow(/acme\/api#999/);
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
