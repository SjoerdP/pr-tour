import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '../../src/shared/diff.js';
import type { Draft, ReviewResponse, ReviewThread } from '../../src/shared/review.js';
import type { Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';
import { response, tour as baseTour } from './tour-fixture.js';

// A jump from the review panel brings its line into view in the code and flashes it, so the
// eye finds the thread or draft without scrolling for it.

vi.mock('../../src/web/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getPr: vi.fn(),
  buildTour: vi.fn(),
  markSeen: vi.fn(),
  getReview: vi.fn(),
  getFile: vi.fn(),
  getDiff: vi.fn(),
}));

vi.mock('../../src/web/highlight.js', () => ({
  highlight: (text: string) => Promise.resolve(text.split('\n').map((line) => [{ content: line }])),
}));

const HEAD = baseTour.headSha;

/** F1.S1 owns all 120 lines of src/a.ts: opening it starts at the top of the file. */
const tour: Tour = {
  ...baseTour,
  flows: baseTour.flows.map((f) => ({
    ...f,
    steps: f.steps.map((s) =>
      s.id === 'F1.S1'
        ? {
            ...s,
            endLine: 120,
            homes: [{ file: 'src/a.ts', side: 'new' as const, start: 1, end: 120 }],
          }
        : s,
    ),
  })),
};

/** Every file: line 2 changed, in one hunk over lines 1-3 of a 120-line file. */
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
    Array.from({ length: 120 }, (_, i) =>
      i === 1 ? `${path} ${sha === HEAD ? 'new' : 'old'} 2` : `${path} ${i + 1}`,
    ).join('\n') + '\n'
  );
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'T1',
    path: 'src/a.ts',
    side: 'new',
    line: 81,
    startLine: null,
    outdated: false,
    resolved: false,
    comments: [
      {
        id: 'c1',
        author: 'bob',
        body: 'Why here?',
        createdAt: '2026-10-28T09:00:00Z',
        url: 'https://github.com/acme/loans/pull/42#discussion_c1',
      },
    ],
    ...overrides,
  };
}

const DRAFT: Draft = {
  id: 5,
  kind: 'comment',
  path: 'src/a.ts',
  side: 'new',
  startLine: 60,
  endLine: 60,
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

const scrollIntoView = vi.fn();

beforeEach(() => {
  vi.mocked(api.getPr).mockResolvedValue(response({ tour }));
  vi.mocked(api.markSeen).mockResolvedValue(undefined);
  vi.mocked(api.getDiff).mockImplementation((_repo, _pr, file) => Promise.resolve(diffOf(file)));
  vi.mocked(api.getFile).mockImplementation((_repo, _pr, sha, path) =>
    Promise.resolve({ text: text(path, sha) }),
  );
  // jsdom does no layout and has no scrollIntoView: record which element asked for it.
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  vi.resetAllMocks();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

/** Opens the tour on its first home (the migration in m.sql), then the Review panel. */
async function openPanel() {
  render(<TourView repo="acme/loans" pr={42} />);
  await screen.findByText('m.sql new 2');
  fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
  return screen.getByRole('region', { name: 'Review' });
}

/** The code row with new-side line `n`. */
const rowOf = (n: number) =>
  screen.getByRole('button', { name: `Comment on line ${n}` }).closest('.code-row')!;

const lastScrolled = () => scrollIntoView.mock.contexts.at(-1) as Element | undefined;

describe('review panel: a jump shows its line', () => {
  it('a thread link scrolls its row into view and flashes it', async () => {
    serveReview({ threads: [thread()] });
    const panel = await openPanel();

    fireEvent.click(await within(panel).findByRole('button', { name: 'src/a.ts:81' }));
    await screen.findByText('src/a.ts new 2');

    await vi.waitFor(() => expect(lastScrolled()).toBe(rowOf(81)));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center' });
    expect(rowOf(81).classList.contains('reveal-flash')).toBe(true);
    expect(rowOf(1).classList.contains('reveal-flash')).toBe(false);
  });

  it('a pending draft link scrolls its row into view and flashes it', async () => {
    serveReview({ drafts: [DRAFT] });
    const panel = await openPanel();

    fireEvent.click(await within(panel).findByRole('button', { name: 'src/a.ts:60' }));
    await screen.findByText('src/a.ts new 2');

    await vi.waitFor(() => expect(lastScrolled()).toBe(rowOf(60)));
    expect(rowOf(60).classList.contains('reveal-flash')).toBe(true);
  });

  it('a file-level thread scrolls to the comments on the file', async () => {
    serveReview({ threads: [thread({ line: null, side: null })] });
    const panel = await openPanel();

    fireEvent.click(await within(panel).findByRole('button', { name: 'src/a.ts' }));
    const block = await screen.findByRole('region', { name: 'Comments on this file' });

    await vi.waitFor(() => expect(lastScrolled()).toBe(block));
    expect(block.classList.contains('reveal-flash')).toBe(true);
  });

  it('a second click on the same thread scrolls to it again', async () => {
    serveReview({ threads: [thread()] });
    const panel = await openPanel();
    const link = await within(panel).findByRole('button', { name: 'src/a.ts:81' });

    fireEvent.click(link);
    await screen.findByText('src/a.ts new 2');
    await vi.waitFor(() => expect(lastScrolled()).toBe(rowOf(81)));
    scrollIntoView.mockClear();

    fireEvent.click(link);
    await vi.waitFor(() => expect(lastScrolled()).toBe(rowOf(81)));
  });

  it('"Go to it" in the approve reminder shows the start of that home', async () => {
    serveReview();
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Approve' }));
    const reminder = within(panel).getByRole('region', { name: 'Not seen yet' });
    const item = within(reminder)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.startsWith('Parse the request'))!;

    fireEvent.click(within(item).getByRole('button', { name: 'Go to it' }));
    await screen.findByText('src/a.ts new 2');

    await vi.waitFor(() => expect(lastScrolled()).toBe(rowOf(1)));
    expect(rowOf(1).classList.contains('reveal-flash')).toBe(true);
  });

  it('moving on with j does not flash anything', async () => {
    serveReview();
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByText('m.sql new 2');
    fireEvent.keyDown(window, { key: 'j' });
    await screen.findByText('src/a.ts new 2');
    expect(document.querySelector('.reveal-flash')).toBeNull();
  });
});
