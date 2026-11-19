import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProblemsResponse } from '../../src/shared/api.js';
import type { Problem } from '../../src/shared/problems.js';
import type { ReviewThread } from '../../src/shared/review.js';
import { getProblems, setProblemMark } from '../../src/web/api.js';
import { useProblems } from '../../src/web/useProblems.js';
import { tour } from './tour-fixture.js';

vi.mock('../../src/web/api.js', () => ({
  getProblems: vi.fn(),
  setProblemMark: vi.fn(),
}));

const get = vi.mocked(getProblems);
const save = vi.mocked(setProblemMark);

// Possible problems for the tour: CI's from the server, plus the open review threads of bots.

function botThread(id: string, overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id,
    path: 'src/a.ts',
    side: 'new',
    line: 4,
    startLine: null,
    outdated: false,
    resolved: false,
    bot: true,
    comments: [
      {
        id: `${id}-c1`,
        author: 'coderabbitai[bot]',
        body: '_⚠️ Potential issue_ | _🟠 Major_\n\n**The fee is charged twice.**',
        createdAt: '2026-11-07T10:00:00Z',
        url: `https://github.com/acme/loans/pull/42#discussion_${id}`,
      },
    ],
    ...overrides,
  };
}

function ci(key: string, level: Problem['level'], at: Problem['at'], title = key): Problem {
  return { key, level, title, sources: ['golangci-lint'], at };
}

function answer(overrides: Partial<ProblemsResponse> = {}): ProblemsResponse {
  return { problems: [], marks: {}, pending: false, outdated: false, error: null, ...overrides };
}

beforeEach(() => {
  get.mockReset();
  save.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useProblems', () => {
  it('adds open bot threads and leaves resolved and outdated ones out', async () => {
    get.mockResolvedValue(answer());
    const threads = [
      botThread('t1'),
      botThread('t2', { resolved: true }),
      botThread('t3', { outdated: true }),
      botThread('t4', { bot: false }),
      botThread('t5', {
        side: null,
        line: null,
        path: 'm.sql',
        comments: [
          {
            id: 'c5',
            author: 'copilot-pull-request-reviewer[bot]',
            body: '_🟠 Major_',
            createdAt: 'x',
            url: 'https://github.com/acme/loans/pull/42#discussion_t5',
          },
        ],
      }),
      botThread('t6', {
        comments: [
          {
            id: 'c6',
            author: 'lint-helper[bot]',
            body: 'Name this better.',
            createdAt: 'x',
            url: 'https://github.com/acme/loans/pull/42#discussion_t6',
          },
        ],
      }),
    ];
    const { result } = renderHook(() => useProblems('acme/loans', 42, tour, threads));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.problems.map((p) => p.key)).toEqual(['bot|t1', 'bot|t5', 'bot|t6']);
    const [rabbit, copilot, other] = result.current.problems;
    expect(rabbit).toEqual({
      key: 'bot|t1',
      level: 'risk',
      title: 'The fee is charged twice.',
      sources: ['CodeRabbit'],
      at: { kind: 'line', file: 'src/a.ts', side: 'new', line: 4 },
      url: 'https://github.com/acme/loans/pull/42#discussion_t1',
      threadId: 't1',
      homeId: 'F1.S1',
    });
    // Nothing but labels: the title says who wrote it.
    expect(copilot).toMatchObject({
      title: 'Comment by Copilot',
      sources: ['Copilot'],
      at: { kind: 'file', file: 'm.sql' },
      homeId: 'f1',
    });
    expect(other).toMatchObject({ sources: ['lint-helper'], level: 'look' });
  });

  it('merges and sorts', async () => {
    get.mockResolvedValue(
      answer({
        problems: [
          ci('near', 'bug', { kind: 'line', file: 'src/a.ts', side: 'new', line: 5 }),
          ci('look', 'look', { kind: 'line', file: 'test/repay.test.ts', side: 'new', line: 2 }),
          ci('pr', 'bug', { kind: 'pr' }, 'CI check "build" fails'),
          ci('mig', 'risk', { kind: 'line', file: 'm.sql', side: 'new', line: 2 }),
        ],
      }),
    );
    const { result } = renderHook(() => useProblems('acme/loans', 42, tour, [botThread('t1')]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The CI annotation one line from the bot thread folds into it, at the worse level.
    expect(result.current.problems.map((p) => [p.key, p.level, p.sources])).toEqual([
      ['pr', 'bug', ['golangci-lint']],
      ['bot|t1', 'bug', ['CodeRabbit', 'golangci-lint']],
      ['mig', 'risk', ['golangci-lint']],
      ['look', 'look', ['golangci-lint']],
    ]);
  });

  it('a failed mark save takes the mark back', async () => {
    get.mockResolvedValue(
      answer({
        problems: [ci('pr', 'bug', { kind: 'pr' })],
        marks: { pr: 'real' },
      }),
    );
    let fail: (err: Error) => void = () => {};
    save.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const { result } = renderHook(() => useProblems('acme/loans', 42, tour, []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.markOf('pr')).toBe('real');

    act(() => result.current.setMark('pr', 'not'));
    // Shown at once, before the server answers.
    expect(result.current.markOf('pr')).toBe('not');
    expect(save).toHaveBeenCalledWith('acme/loans', 42, 'pr', 'not');

    await act(async () => {
      fail(new Error('disk full'));
      await Promise.resolve();
    });
    expect(result.current.markOf('pr')).toBe('real');
    expect(result.current.error).toBe('Could not save the mark: disk full');
    expect(result.current.errorKey).toBe('pr');
  });

  it('keeps the same value while nothing changed', async () => {
    get.mockResolvedValue(answer({ problems: [ci('pr', 'bug', { kind: 'pr' })] }));
    const threads: ReviewThread[] = [];
    const { result, rerender } = renderHook(() => useProblems('acme/loans', 42, tour, threads));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('passes on the notes from the server', async () => {
    get.mockResolvedValue(
      answer({ pending: true, outdated: true, error: 'Could not read CI results from GitHub: x' }),
    );
    const { result } = renderHook(() => useProblems('acme/loans', 42, tour, []));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pending).toBe(true);
    expect(result.current.outdated).toBe(true);
    expect(result.current.note).toBe('Could not read CI results from GitHub: x');
  });

  it('reads again every minute while CI runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    get.mockResolvedValueOnce(answer({ pending: true }));
    get.mockResolvedValueOnce(answer({ problems: [ci('pr', 'bug', { kind: 'pr' })] }));
    const { result } = renderHook(() => useProblems('acme/loans', 42, tour, []));
    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.problems.map((p) => p.key)).toEqual(['pr']);
    // Not pending: no more reads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('says when the problems could not be read', async () => {
    get.mockRejectedValue(new Error('server down'));
    const { result } = renderHook(() => useProblems('acme/loans', 42, tour, []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.note).toBe('Could not read possible problems: server down');
  });

  it('reads nothing without a tour', () => {
    const { result } = renderHook(() => useProblems('acme/loans', 42, null, [botThread('t1')]));
    expect(get).not.toHaveBeenCalled();
    expect(result.current.problems).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
