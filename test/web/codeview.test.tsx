import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '../../src/shared/diff.js';
import type { Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { CodeView } from '../../src/web/CodeView.js';

vi.mock('../../src/web/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getFile: vi.fn(),
  getDiff: vi.fn(),
}));

/** Paths passed to highlight(), in order. */
const highlighted = vi.hoisted((): string[] => []);

// Shiki is not what these tests are about: one plain token per line.
vi.mock('../../src/web/highlight.js', () => ({
  highlight: (text: string, path: string) => {
    highlighted.push(path);
    return Promise.resolve(text.split('\n').map((line) => [{ content: line }]));
  },
}));

const getFile = vi.mocked(api.getFile);
const getDiff = vi.mocked(api.getDiff);

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function lines(n: number, change: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
}

/** A hunk replacing line `at` (1-based) of a file, with no context lines. */
function replaceHunk(at: number, oldText: string, newText: string) {
  return {
    oldStart: at,
    oldLines: 1,
    newStart: at,
    newLines: 1,
    lines: [
      { kind: 'del' as const, oldNo: at, text: oldText },
      { kind: 'add' as const, newNo: at, text: newText },
    ],
  };
}

function makeTour(overrides: Partial<Tour> = {}): Tour {
  return {
    repo: 'acme/loans',
    pr: 42,
    baseSha: BASE,
    headSha: HEAD,
    source: 'author',
    createdAt: '2026-10-27T12:00:00Z',
    summary: 'Adds early repayment of loans.',
    foundations: [],
    flows: [
      {
        id: 'F1',
        title: 'Repay a loan',
        entry: { kind: 'http', label: 'POST /loans/{id}/repay' },
        steps: [
          {
            id: 'F1.S1',
            title: 'Record the repayment',
            file: 'src/repay.ts',
            startLine: 5,
            endLine: 5,
            changed: true,
            why: 'Stores it.',
            risk: 'skim',
            sideEffects: [],
            tests: [],
            calls: [],
            homes: [{ file: 'src/repay.ts', side: 'new', start: 5, end: 5 }],
          },
        ],
      },
    ],
    other: [],
    check: { problems: [] },
    hashes: {},
    ...overrides,
  };
}

/** Serves `files` (keyed `sha:path`) and `diff` through the mocked api. */
function serve(diff: FileDiff, files: Record<string, string>) {
  getDiff.mockResolvedValue(diff);
  getFile.mockImplementation((_repo, _pr, sha, path) =>
    Promise.resolve({ text: files[`${sha}:${path}`] ?? null }),
  );
}

function modified(path: string, hunks: FileDiff['hunks']): FileDiff {
  return { path, oldPath: path, status: 'modified', binary: false, hunks };
}

type Props = Parameters<typeof CodeView>[0];

function renderView(props: Partial<Props> = {}) {
  const onJump = vi.fn();
  const onOpenHome = vi.fn();
  render(
    <CodeView
      repo="acme/loans"
      pr={42}
      tour={makeTour()}
      file="src/repay.ts"
      focus={{ start: 5, end: 5 }}
      homeId="F1.S1"
      onJump={onJump}
      onOpenHome={onOpenHome}
      {...props}
    />,
  );
  return { onJump, onOpenHome };
}

beforeEach(() => {
  vi.resetAllMocks();
  highlighted.length = 0;
});

describe('CodeView', () => {
  it('folds unchanged code and opens a fold on click', async () => {
    serve(modified('src/repay.ts', [replaceHunk(20, 'old twenty', 'new twenty')]), {
      [`${HEAD}:src/repay.ts`]: lines(30, { 20: 'new twenty' }),
      [`${BASE}:src/repay.ts`]: lines(30, { 20: 'old twenty' }),
    });
    renderView({ focus: { start: 20, end: 20 } });

    expect(await screen.findByText('new twenty')).toBeTruthy();
    expect(screen.getByText('old twenty')).toBeTruthy();
    // Three lines of context stay open around the change; lines 1-16 are folded.
    expect(screen.getByText('line 17')).toBeTruthy();
    expect(screen.queryByText('line 5')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '⋯ 16 unchanged lines ⋯' }));
    expect(screen.getByText('line 5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '⋯ 16 unchanged lines ⋯' })).toBeNull();
  });

  it('keeps the focus range open even when it is unchanged', async () => {
    serve(modified('src/repay.ts', [replaceHunk(20, 'old twenty', 'new twenty')]), {
      [`${HEAD}:src/repay.ts`]: lines(30, { 20: 'new twenty' }),
      [`${BASE}:src/repay.ts`]: lines(30, { 20: 'old twenty' }),
    });
    renderView({ focus: { start: 5, end: 6 } });

    expect(await screen.findByText('line 5')).toBeTruthy();
    expect(screen.getByText('line 6')).toBeTruthy();
    expect(screen.queryByText('line 10')).toBeNull();
  });

  it('n moves to the next change and updates the counter', async () => {
    serve(
      modified('src/repay.ts', [
        replaceHunk(5, 'old five', 'new five'),
        replaceHunk(25, 'old twenty-five', 'new twenty-five'),
      ]),
      {
        [`${HEAD}:src/repay.ts`]: lines(30, { 5: 'new five', 25: 'new twenty-five' }),
        [`${BASE}:src/repay.ts`]: lines(30, { 5: 'old five', 25: 'old twenty-five' }),
      },
    );
    renderView();

    expect(await screen.findByText('change 1 of 2 in this file')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'n' });
    expect(screen.getByText('change 2 of 2 in this file')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'n' });
    expect(screen.getByText('change 2 of 2 in this file')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Prev change' }));
    expect(screen.getByText('change 1 of 2 in this file')).toBeTruthy();
  });

  it('the toolbar buttons name their keys in their tooltips', async () => {
    serve(modified('src/repay.ts', [replaceHunk(5, 'old five', 'new five')]), {
      [`${HEAD}:src/repay.ts`]: lines(10, { 5: 'new five' }),
      [`${BASE}:src/repay.ts`]: lines(10, { 5: 'old five' }),
    });
    renderView();

    await screen.findByText('change 1 of 1 in this file');
    const titles = ['Prev change', 'Next change', 'Whole file'].map(
      (name) => screen.getByRole('button', { name }).title,
    );
    expect(titles).toEqual(['Prev change (p)', 'Next change (n)', 'Whole file (f)']);
  });

  it('f shows the whole file', async () => {
    serve(modified('src/repay.ts', [replaceHunk(20, 'old twenty', 'new twenty')]), {
      [`${HEAD}:src/repay.ts`]: lines(30, { 20: 'new twenty' }),
      [`${BASE}:src/repay.ts`]: lines(30, { 20: 'old twenty' }),
    });
    renderView({ focus: { start: 20, end: 20 } });
    await screen.findByText('new twenty');

    fireEvent.keyDown(window, { key: 'f' });
    expect(screen.getByText('line 1')).toBeTruthy();
    expect(screen.getByText('line 30')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /unchanged lines/ })).toBeNull();

    fireEvent.keyDown(window, { key: 'f' });
    expect(screen.queryByText('line 1')).toBeNull();
  });

  it('labels a change that belongs to another item', async () => {
    serve(
      modified('src/repay.ts', [
        replaceHunk(5, 'old five', 'new five'),
        replaceHunk(25, 'old twenty-five', 'new twenty-five'),
      ]),
      {
        [`${HEAD}:src/repay.ts`]: lines(30, { 5: 'new five', 25: 'new twenty-five' }),
        [`${BASE}:src/repay.ts`]: lines(30, { 5: 'old five', 25: 'old twenty-five' }),
      },
    );
    const tour = makeTour({
      other: [
        {
          kind: 'refactor',
          title: 'Refactors',
          summary: 'Small cleanups.',
          items: [
            {
              id: 'o1.1',
              file: 'src/repay.ts',
              title: 'Rename the helper',
              homes: [
                { file: 'src/repay.ts', side: 'new', start: 25, end: 25 },
                { file: 'src/repay.ts', side: 'old', start: 25, end: 25 },
              ],
            },
          ],
        },
      ],
    });
    const { onOpenHome } = renderView({ tour });

    await screen.findByText('new twenty-five');
    // One label for the run of changed rows, none on this step's own change.
    const labels = screen.getAllByRole('button', { name: 'belongs to Rename the helper' });
    expect(labels).toHaveLength(1);
    fireEvent.click(labels[0]!);
    expect(onOpenHome).toHaveBeenCalledWith('o1.1');
  });

  it('matches deleted lines of a renamed file by the old path', async () => {
    serve(
      {
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        status: 'renamed',
        binary: false,
        hunks: [replaceHunk(5, 'old five', 'new five')],
      },
      {
        [`${HEAD}:src/new.ts`]: lines(10, { 5: 'new five' }),
        [`${BASE}:src/old.ts`]: lines(10, { 5: 'old five' }),
      },
    );
    const tour = makeTour({
      other: [
        {
          kind: 'refactor',
          title: 'Refactors',
          summary: 'Small cleanups.',
          items: [
            {
              id: 'o1.1',
              file: 'src/new.ts',
              title: 'Old code removed',
              homes: [{ file: 'src/old.ts', side: 'old', start: 5, end: 5 }],
            },
            {
              id: 'o1.2',
              file: 'src/new.ts',
              title: 'New code added',
              homes: [{ file: 'src/new.ts', side: 'new', start: 5, end: 5 }],
            },
          ],
        },
      ],
    });
    renderView({ tour, file: 'src/new.ts', homeId: 'F1.S1' });

    expect(await screen.findByText('old five')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'belongs to Old code removed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'belongs to New code added' })).toBeTruthy();
  });

  it('clicking a traced call calls onJump with its file and line', async () => {
    serve(modified('src/repay.ts', [replaceHunk(5, 'old five', '  chargeFee(loan);')]), {
      [`${HEAD}:src/repay.ts`]: lines(10, { 5: '  chargeFee(loan);', 8: 'chargeFee(other);' }),
      [`${BASE}:src/repay.ts`]: lines(10, { 5: 'old five', 8: 'chargeFee(other);' }),
    });
    const tour = makeTour();
    tour.flows[0]!.steps[0]!.calls = [{ symbol: 'chargeFee', file: 'src/fees.ts', line: 12 }];
    const { onJump } = renderView({ tour });

    const call = await screen.findByRole('button', { name: 'chargeFee' });
    // Only the call inside the step's lines is traced; line 8 is outside them.
    expect(screen.getAllByRole('button', { name: 'chargeFee' })).toHaveLength(1);
    fireEvent.click(call);
    expect(onJump).toHaveBeenCalledWith('src/fees.ts', 12);
  });

  it('shows an unchanged file (a followed call) with the line in view', async () => {
    getDiff.mockRejectedValue(new api.ApiError(404, 'src/fees.ts is not changed in this tour'));
    getFile.mockResolvedValue({ text: lines(40) });
    renderView({ file: 'src/fees.ts', focus: { start: 12, end: 12 } });

    expect(await screen.findByText('line 12')).toBeTruthy();
    expect(screen.queryByText('line 30')).toBeNull();
    expect(screen.getByText('no changes in this file')).toBeTruthy();
  });

  it('highlights the code, unless asked to show it plain', async () => {
    const diff = modified('src/repay.ts', [replaceHunk(5, 'old', 'new')]);
    serve(diff, {
      [`${BASE}:src/repay.ts`]: lines(6, { 5: 'old' }),
      [`${HEAD}:src/repay.ts`]: lines(6, { 5: 'new' }),
    });

    renderView();
    await screen.findByText('new');
    await vi.waitFor(() => expect(highlighted).toContain('src/repay.ts'));
    cleanup();
    highlighted.length = 0;

    renderView({ plain: true });
    await screen.findByText('new');
    expect(highlighted).toEqual([]);
  });

  it('binary file shows a placeholder', async () => {
    getDiff.mockResolvedValue({
      path: 'img/logo.png',
      oldPath: 'img/logo.png',
      status: 'modified',
      binary: true,
      hunks: [],
    });
    renderView({ file: 'img/logo.png', focus: null });

    expect(await screen.findByText('Binary file changed')).toBeTruthy();
    expect(getFile).not.toHaveBeenCalled();
  });

  it('shows a load error', async () => {
    getDiff.mockRejectedValue(new api.ApiError(500, 'git failed'));
    renderView();
    expect((await screen.findByRole('alert')).textContent).toContain('git failed');
  });
});
