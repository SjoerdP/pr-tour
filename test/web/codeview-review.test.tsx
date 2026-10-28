import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff, Hunk } from '../../src/shared/diff.js';
import type { Draft, DraftComment, ReviewThread } from '../../src/shared/review.js';
import type { Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { draftRows, threadRows } from '../../src/web/code-lines.js';
import { CodeView } from '../../src/web/CodeView.js';
import { buildRows } from '../../src/shared/rows.js';
import type { ReviewState } from '../../src/web/useReview.js';
import { fakeReview } from './review-fake.js';

// Comments in the code view: selecting lines, the composer, threads and drafts in place.

vi.mock('../../src/web/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getFile: vi.fn(),
  getDiff: vi.fn(),
}));

vi.mock('../../src/web/highlight.js', () => ({
  highlight: (text: string) => Promise.resolve(text.split('\n').map((line) => [{ content: line }])),
}));

const getFile = vi.mocked(api.getFile);
const getDiff = vi.mocked(api.getDiff);

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const PATH = 'src/repay.ts';

function lines(n: number, change: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
}

/** One hunk on lines 4-7: line 5 replaced, three lines of context. */
const HUNK: Hunk = {
  oldStart: 4,
  oldLines: 4,
  newStart: 4,
  newLines: 4,
  lines: [
    { kind: 'ctx', oldNo: 4, newNo: 4, text: 'line 4' },
    { kind: 'del', oldNo: 5, text: 'old five' },
    { kind: 'add', newNo: 5, text: 'new five' },
    { kind: 'ctx', oldNo: 6, newNo: 6, text: 'line 6' },
    { kind: 'ctx', oldNo: 7, newNo: 7, text: 'line 7' },
  ],
};

const DIFF: FileDiff = {
  path: PATH,
  oldPath: PATH,
  status: 'modified',
  binary: false,
  hunks: [HUNK],
};

function makeTour(): Tour {
  return {
    repo: 'acme/loans',
    pr: 42,
    baseSha: BASE,
    headSha: HEAD,
    source: 'author',
    createdAt: '2026-10-27T12:00:00Z',
    summary: 'Adds early repayment of loans.',
    foundations: [],
    flows: [],
    other: [],
    check: { problems: [] },
    hashes: {},
  };
}

function serve(diff: FileDiff = DIFF) {
  getDiff.mockResolvedValue(diff);
  const files: Record<string, string> = {
    [`${HEAD}:${PATH}`]: lines(30, { 5: 'new five' }),
    [`${BASE}:${PATH}`]: lines(30, { 5: 'old five' }),
  };
  getFile.mockImplementation((_repo, _pr, sha, path) =>
    Promise.resolve({ text: files[`${sha}:${path}`] ?? null }),
  );
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'T1',
    path: PATH,
    side: 'new',
    line: 5,
    startLine: null,
    outdated: false,
    resolved: false,
    comments: [
      {
        id: 'c1',
        author: 'alice',
        body: 'Why this change?',
        createdAt: '2026-10-28T09:00:00Z',
        url: 'https://github.com/acme/loans/pull/42#discussion_c1',
      },
    ],
    ...overrides,
  };
}

function draft(overrides: Partial<DraftComment> = {}): Draft {
  return {
    id: 7,
    kind: 'comment',
    path: PATH,
    side: 'new',
    startLine: 6,
    endLine: 6,
    placement: 'line',
    quote: 'line 6',
    headSha: HEAD,
    body: 'Rename this',
    createdAt: '2026-10-28T10:00:00Z',
    ...overrides,
  };
}

function renderView(
  review: ReviewState = fakeReview(),
  props: Partial<Parameters<typeof CodeView>[0]> = {},
) {
  render(
    <CodeView
      repo="acme/loans"
      pr={42}
      tour={makeTour()}
      file={PATH}
      focus={{ start: 5, end: 5 }}
      homeId="F1.S1"
      review={review}
      onJump={vi.fn()}
      onOpenHome={vi.fn()}
      {...props}
    />,
  );
  return review;
}

const lineButton = (n: number) => screen.getByRole('button', { name: `Comment on line ${n}` });
const field = () => screen.getByRole('textbox', { name: `Comment on ${PATH}` });

/** The code row that review items (a thread, a draft, the composer) are shown under. */
function rowAbove(el: Element): Element {
  const items = el.closest('.code-review-row');
  if (!items) throw new Error('not shown under a row');
  return items.previousElementSibling!;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('CodeView: commenting on lines', () => {
  it('each line number is a button; a click opens the composer with a line target', async () => {
    serve();
    renderView();
    await screen.findByText('new five');

    fireEvent.click(lineButton(5));
    expect(rowAbove(field()).textContent).toContain('new five');
    // In the diff: no file-level notice, and a suggestion can start from the line.
    expect(document.querySelector('.composer-notice')).toBeNull();
    expect(screen.getByRole('button', { name: 'Suggest change' })).toBeTruthy();
  });

  it('shift+click extends the selection to a range; the composer sits under its last row', async () => {
    serve();
    renderView();
    await screen.findByText('new five');

    fireEvent.click(lineButton(7));
    fireEvent.click(lineButton(5), { shiftKey: true });
    const selected = [...document.querySelectorAll('.code-selected')].map(
      (row) => row.querySelector('.code-text')!.textContent,
    );
    expect(selected).toEqual(['new five', 'line 6', 'line 7']);
    expect(rowAbove(field()).textContent).toContain('line 7');
  });

  it('submitting the composer adds a draft and closes it', async () => {
    serve();
    const review = renderView();
    await screen.findByText('new five');

    fireEvent.click(lineButton(5));
    fireEvent.click(lineButton(6), { shiftKey: true });
    fireEvent.change(field(), { target: { value: 'Looks off' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));

    await vi.waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(review.add).toHaveBeenCalledWith({
      kind: 'comment',
      path: PATH,
      side: 'new',
      startLine: 5,
      endLine: 6,
      body: 'Looks off',
    });
    expect(document.querySelector('.code-selected')).toBeNull();
  });

  it('a deleted line is commented on the old side', async () => {
    serve();
    const review = renderView();
    await screen.findByText('old five');

    fireEvent.click(screen.getByRole('button', { name: 'Comment on old line 5' }));
    expect(rowAbove(field()).textContent).toContain('old five');
    // Nothing to suggest on the old side.
    expect(screen.queryByRole('button', { name: 'Suggest change' })).toBeNull();
    fireEvent.change(field(), { target: { value: 'Was this used?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));

    await vi.waitFor(() =>
      expect(review.add).toHaveBeenCalledWith({
        kind: 'comment',
        path: PATH,
        side: 'old',
        startLine: 5,
        endLine: 5,
        body: 'Was this used?',
      }),
    );
  });

  it('a line outside the diff says it becomes a file-level comment', async () => {
    serve();
    renderView();
    await screen.findByText('new five');

    fireEvent.click(lineButton(2));
    expect(document.querySelector('.composer-notice')!.textContent).toBe(
      'Line 2 is not in the diff. This will be sent as a file-level comment quoting the line.',
    );
  });

  it('a range that crosses the hunk boundary also becomes file-level', async () => {
    serve();
    renderView();
    await screen.findByText('new five');

    fireEvent.click(lineButton(3));
    fireEvent.click(lineButton(5), { shiftKey: true });
    expect(document.querySelector('.composer-notice')!.textContent).toContain(
      'Lines 3–5 are not in the diff.',
    );
  });

  it('shift+click on the other side starts a new selection', async () => {
    serve();
    renderView();
    await screen.findByText('new five');

    fireEvent.click(lineButton(6));
    fireEvent.click(screen.getByRole('button', { name: 'Comment on old line 5' }), {
      shiftKey: true,
    });
    const selected = [...document.querySelectorAll('.code-selected')].map(
      (row) => row.querySelector('.code-text')!.textContent,
    );
    expect(selected).toEqual(['old five']);
    expect(rowAbove(field()).textContent).toContain('old five');
  });

  it('typed text stays when shift+click moves the composer to a new last row', async () => {
    serve();
    renderView();
    await screen.findByText('new five');

    fireEvent.click(lineButton(5));
    fireEvent.change(field(), { target: { value: 'Half a thought' } });
    fireEvent.click(lineButton(7), { shiftKey: true });
    expect(rowAbove(field()).textContent).toContain('line 7');
    expect((field() as HTMLTextAreaElement).value).toBe('Half a thought');
  });

  it('typed text stays when the whole file folds back up', async () => {
    serve();
    renderView();
    await screen.findByText('new five');

    fireEvent.click(screen.getByRole('button', { name: 'Whole file' }));
    fireEvent.click(lineButton(20));
    fireEvent.change(field(), { target: { value: 'About line 20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Whole file' }));

    // Line 20 is outside the changes, but the selection keeps it open.
    expect(screen.getByText('line 20')).toBeTruthy();
    expect((field() as HTMLTextAreaElement).value).toBe('About line 20');
    expect(rowAbove(field()).textContent).toContain('line 20');
  });

  it('a file the PR does not change has no line buttons', async () => {
    getDiff.mockRejectedValue(new api.ApiError(404, 'src/fees.ts is not changed in this tour'));
    getFile.mockResolvedValue({ text: lines(10) });
    renderView(fakeReview(), { file: 'src/fees.ts', focus: { start: 5, end: 5 } });

    expect(await screen.findByText('line 5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Comment on/ })).toBeNull();
  });

  it('Cancel closes the composer and clears the selection', async () => {
    serve();
    renderView();
    await screen.findByText('new five');

    fireEvent.click(lineButton(5));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('.code-selected')).toBeNull();
  });
});

describe('CodeView: threads and drafts in place', () => {
  it('shows a new-side thread after its row', async () => {
    serve();
    renderView(fakeReview({ threads: [thread()] }));

    const text = await screen.findByText('Why this change?');
    expect(rowAbove(text).querySelector('.code-text')!.textContent).toBe('new five');
  });

  it('shows an old-side thread after the deleted row', async () => {
    serve();
    renderView(fakeReview({ threads: [thread({ side: 'old', line: 5 })] }));

    const text = await screen.findByText('Why this change?');
    expect(rowAbove(text).querySelector('.code-text')!.textContent).toBe('old five');
  });

  it('replying to a thread adds a reply draft', async () => {
    serve();
    const review = renderView(fakeReview({ threads: [thread()] }));
    await screen.findByText('Why this change?');

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(field(), { target: { value: 'Because' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reply' }));
    await vi.waitFor(() =>
      expect(review.add).toHaveBeenCalledWith({ kind: 'reply', threadId: 'T1', body: 'Because' }),
    );
  });

  it('outdated and file-level threads go to the "Comments on this file" block', async () => {
    serve();
    renderView(
      fakeReview({
        threads: [
          thread({ id: 'T1', outdated: true }),
          thread({
            id: 'T2',
            side: null,
            line: null,
            comments: [{ ...thread().comments[0]!, id: 'c2', body: 'About the whole file' }],
          }),
        ],
      }),
    );

    const block = await screen.findByRole('region', { name: 'Comments on this file' });
    expect(within(block).getByText('Why this change?')).toBeTruthy();
    expect(within(block).getByText('About the whole file')).toBeTruthy();
    expect(document.querySelector('.code-review-row')).toBeNull();
  });

  it('shows a draft as a Pending card after its row; it can be edited and deleted', async () => {
    serve();
    const review = renderView(fakeReview({ drafts: [draft()] }));

    const body = await screen.findByText('Rename this');
    expect(rowAbove(body).querySelector('.code-text')!.textContent).toBe('line 6');
    const card = body.closest('.draft-card') as HTMLElement;
    expect(within(card).getByText('Pending')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    fireEvent.change(field(), { target: { value: 'Rename this to total' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(review.update).toHaveBeenCalledWith(7, 'Rename this to total'));

    fireEvent.click(await within(card).findByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(review.remove).toHaveBeenCalledWith(7));
  });

  it('a draft made on an older head goes to the top block, not to a line', async () => {
    serve();
    renderView(fakeReview({ drafts: [draft({ headSha: 'c'.repeat(40) })] }));

    const block = await screen.findByRole('region', { name: 'Comments on this file' });
    expect(within(block).getByText('Rename this')).toBeTruthy();
    expect(document.querySelector('.code-review-row')).toBeNull();
    expect(within(block).getByText('older version')).toBeTruthy();
    expect(
      within(block).getByText(
        'Made on an older version of this PR. It will be sent as a file-level comment that quotes the lines.',
      ),
    ).toBeTruthy();
  });

  it('a draft on the current head has no older-version label', async () => {
    serve();
    renderView(fakeReview({ drafts: [draft()] }));
    await screen.findByText('Rename this');
    expect(screen.queryByText('older version')).toBeNull();
  });

  it('a fold with a thread or a draft in it is shown open', async () => {
    serve();
    renderView(
      fakeReview({
        threads: [thread({ line: 25 })],
        drafts: [draft({ startLine: 15, endLine: 15 })],
      }),
    );

    const text = await screen.findByText('Why this change?');
    expect(rowAbove(text).querySelector('.code-text')!.textContent).toBe('line 25');
    expect(rowAbove(screen.getByText('Rename this')).textContent).toContain('line 15');
    // Rows between them stay folded.
    expect(screen.queryByText('line 20')).toBeNull();
  });
});

describe('CodeView: binary files', () => {
  it('shows file-level comments above the placeholder', async () => {
    getDiff.mockResolvedValue({
      path: 'img/logo.png',
      oldPath: 'img/logo.png',
      status: 'modified',
      binary: true,
      hunks: [],
    });
    renderView(
      fakeReview({ threads: [thread({ path: 'img/logo.png', side: null, line: null })] }),
      { file: 'img/logo.png', focus: null },
    );

    expect(await screen.findByText('Binary file changed')).toBeTruthy();
    const block = screen.getByRole('region', { name: 'Comments on this file' });
    expect(within(block).getByText('Why this change?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Comment on line/ })).toBeNull();
  });
});

describe('threadRows / draftRows', () => {
  const rows = buildRows(lines(10, { 5: 'new five' }), lines(10, { 5: 'old five' }), [HUNK]);
  // Rows: 0-3 lines 1-4, 4 old five, 5 new five, 6.. lines 6-10.

  it('places threads by side and line; outdated, file-level or missing lines go to -1', () => {
    const placed = threadRows(rows, [
      thread({ id: 'new' }),
      thread({ id: 'old', side: 'old' }),
      thread({ id: 'ctx-old', side: 'old', line: 6 }),
      thread({ id: 'outdated', outdated: true }),
      thread({ id: 'file', side: null, line: null }),
      thread({ id: 'gone', line: 99 }),
    ]);
    const ids = (i: number) => placed.get(i)?.map((t) => t.id);
    expect(ids(5)).toEqual(['new']);
    expect(ids(4)).toEqual(['old']);
    expect(ids(6)).toEqual(['ctx-old']);
    expect(ids(-1)).toEqual(['outdated', 'file', 'gone']);
  });

  it('places drafts at their last line; older-head drafts go to -1', () => {
    const placed = draftRows(
      rows,
      [
        draft({ id: 1, startLine: 4, endLine: 5 }) as DraftComment,
        draft({ id: 2, side: 'old', startLine: 5, endLine: 5 }) as DraftComment,
        draft({ id: 3, headSha: 'c'.repeat(40) }) as DraftComment,
      ],
      HEAD,
    );
    expect(placed.get(5)?.map((d) => d.id)).toEqual([1]);
    expect(placed.get(4)?.map((d) => d.id)).toEqual([2]);
    expect(placed.get(-1)?.map((d) => d.id)).toEqual([3]);
  });
});
