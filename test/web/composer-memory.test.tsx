import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '../../src/shared/diff.js';
import type { Draft, ReviewResponse, ReviewThread } from '../../src/shared/review.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';
import { outlineItem } from './outline-helpers.js';
import { response, tour } from './tour-fixture.js';

// Typed text survives moving around the tour: the code view remounts on another step, a
// followed call or a "go to", but what the reviewer was writing comes back with the file.

vi.mock('../../src/web/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getPr: vi.fn(),
  buildTour: vi.fn(),
  markSeen: vi.fn(),
  getReview: vi.fn(),
  getFile: vi.fn(),
  getDiff: vi.fn(),
  addDraft: vi.fn(),
  updateDraft: vi.fn(),
}));

vi.mock('../../src/web/highlight.js', () => ({
  highlight: (text: string) => Promise.resolve(text.split('\n').map((line) => [{ content: line }])),
}));

const HEAD = tour.headSha;

/** Every file: line 2 changed, in one hunk over lines 1-3 of a 9-line file. */
function diffOf(path: string): FileDiff {
  return {
    path,
    oldPath: path,
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: 'ctx', oldNo: 1, newNo: 1, text: `${path} 1` },
          { kind: 'del', oldNo: 2, text: `${path} old 2` },
          { kind: 'add', newNo: 2, text: `${path} new 2` },
          { kind: 'ctx', oldNo: 3, newNo: 3, text: `${path} 3` },
        ],
      },
    ],
  };
}

function text(path: string, sha: string): string {
  return (
    Array.from({ length: 9 }, (_, i) =>
      i === 1 ? `${path} ${sha === HEAD ? 'new' : 'old'} 2` : `${path} ${i + 1}`,
    ).join('\n') + '\n'
  );
}

const THREAD: ReviewThread = {
  id: 'T1',
  path: 'm.sql',
  side: 'new',
  line: 2,
  startLine: null,
  outdated: false,
  resolved: false,
  comments: [
    {
      id: 'c1',
      author: 'bob',
      body: 'Why this column?',
      createdAt: '2026-10-28T09:00:00Z',
      url: 'https://github.com/acme/loans/pull/42#discussion_c1',
    },
  ],
};

const DRAFT: Draft = {
  id: 5,
  kind: 'comment',
  path: 'm.sql',
  side: 'new',
  startLine: 3,
  endLine: 3,
  placement: 'line',
  quote: 'x',
  headSha: HEAD,
  body: 'Saved text',
  createdAt: '2026-10-28T10:00:00Z',
};

function serveReview(overrides: Partial<ReviewResponse> = {}) {
  vi.mocked(api.getReview).mockResolvedValue({
    viewerIsAuthor: false,
    headSha: HEAD,
    threads: [],
    drafts: [],
    ci: { state: 'none', failing: null },
    ...overrides,
  });
}

beforeEach(() => {
  vi.mocked(api.getPr).mockResolvedValue(response());
  vi.mocked(api.markSeen).mockResolvedValue(undefined);
  vi.mocked(api.getDiff).mockImplementation((_repo, _pr, file) => Promise.resolve(diffOf(file)));
  vi.mocked(api.getFile).mockImplementation((_repo, _pr, sha, path) =>
    Promise.resolve({ text: text(path, sha) }),
  );
});

afterEach(() => {
  vi.resetAllMocks();
});

/** Opens the tour on its first home, the foundation in m.sql. */
async function openOnMigration() {
  render(<TourView repo="acme/loans" pr={42} />);
  await screen.findByText('m.sql new 2');
}

const commentField = (path: string) =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: `Comment on ${path}` });

/** To the next step (src/a.ts) and back to the migration. */
async function awayAndBack() {
  fireEvent.keyDown(window, { key: 'j' });
  await screen.findByText('src/a.ts new 2');
  expect(screen.queryByText('m.sql new 2')).toBeNull();
  fireEvent.keyDown(window, { key: 'k' });
  await screen.findByText('m.sql new 2');
}

describe('typed text across moves', () => {
  it('a new comment keeps its selection and text after j and k', async () => {
    serveReview();
    await openOnMigration();

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 3' }), { shiftKey: true });
    fireEvent.change(commentField('m.sql'), { target: { value: 'Half a thought' } });

    await awayAndBack();

    expect(commentField('m.sql').value).toBe('Half a thought');
    const selected = [...document.querySelectorAll('.code-selected')].map(
      (row) => row.querySelector('.code-text')!.textContent,
    );
    expect(selected).toEqual(['m.sql new 2', 'm.sql 3']);
  });

  it('a comment that was added does not come back', async () => {
    serveReview();
    vi.mocked(api.addDraft).mockResolvedValue({ ...DRAFT, id: 9, body: 'Done' });
    await openOnMigration();

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 2' }));
    fireEvent.change(commentField('m.sql'), { target: { value: 'Done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    await vi.waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());

    await awayAndBack();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('.code-selected')).toBeNull();
  });

  it('a cancelled comment does not come back', async () => {
    serveReview();
    await openOnMigration();

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await awayAndBack();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a reply keeps its text after j and k', async () => {
    serveReview({ threads: [THREAD] });
    await openOnMigration();

    const thread = await screen.findByRole('region', { name: 'Thread on m.sql' });
    fireEvent.click(within(thread).getByRole('button', { name: 'Reply' }));
    fireEvent.change(commentField('m.sql'), { target: { value: 'Because of fees' } });

    await awayAndBack();

    const back = await screen.findByRole('region', { name: 'Thread on m.sql' });
    expect(within(back).getByRole<HTMLTextAreaElement>('textbox').value).toBe('Because of fees');
  });

  it('an edit of a draft keeps its text after j and k', async () => {
    serveReview({ drafts: [DRAFT] });
    await openOnMigration();

    await screen.findByText('Saved text');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(commentField('m.sql'), { target: { value: 'Saved text, edited' } });

    await awayAndBack();

    expect((await screen.findByRole<HTMLTextAreaElement>('textbox')).value).toBe(
      'Saved text, edited',
    );
  });

  it('the text also comes back after opening another item from the outline', async () => {
    serveReview();
    await openOnMigration();

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 2' }));
    fireEvent.change(commentField('m.sql'), { target: { value: 'Keep me' } });
    fireEvent.click(outlineItem('Repay tests'));
    await screen.findByText('test/repay.test.ts new 2');
    fireEvent.click(outlineItem('Create repayments table'));
    await screen.findByText('m.sql new 2');

    expect(commentField('m.sql').value).toBe('Keep me');
  });
});
