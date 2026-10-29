import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draft, ReviewResponse, ReviewThread } from '../../src/shared/review.js';
import type { Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { REVIEW_COLUMN_QUERY } from '../../src/web/review-column.js';
import { TourView } from '../../src/web/TourView.js';
import { outlineItem } from './outline-helpers.js';
import { response, tour as baseTour } from './tour-fixture.js';

// The main screen around the code: top bar, About panel, step header, extras, bottom bar.

vi.mock('../../src/web/api.js', () => ({
  getPr: vi.fn(),
  buildTour: vi.fn(),
  markSeen: vi.fn(),
  getReview: vi.fn(),
}));

vi.mock('../../src/web/CodeView.js', () => ({
  CodeView: ({ homeId }: { homeId: string }) => <div data-testid="code-view">{homeId}</div>,
}));

const getPr = vi.mocked(api.getPr);
const markSeen = vi.mocked(api.markSeen);
const getReview = vi.mocked(api.getReview);

function facts(): string[] {
  return within(screen.getByRole('list', { name: 'Step facts' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');
}

function trail(): string {
  return screen.getByTestId('step-trail').textContent ?? '';
}

async function open(tour: Tour = baseTour) {
  getPr.mockResolvedValue(response({ tour }));
  const view = render(<TourView repo="acme/loans" pr={42} />);
  await screen.findByRole('navigation', { name: 'Tour outline' });
  return view;
}

beforeEach(() => {
  markSeen.mockResolvedValue(undefined);
  // Most tests are not about the review: it never arrives.
  getReview.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  delete (window as Partial<Window>).matchMedia;
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('top bar', () => {
  it('shows the PR, then flows, progress and where the notes come from', async () => {
    getPr.mockResolvedValue(response({ seen: { 'F1.S1': 'h-11' } }));
    render(<TourView repo="acme/loans" pr={42} />);

    const bar = await screen.findByRole('banner');
    expect(within(bar).getByRole('link', { name: '← Inbox' }).getAttribute('href')).toBe('/');
    expect(within(bar).getByRole('heading', { level: 1 }).textContent).toBe(
      'acme/loans#42 Early repayment',
    );
    expect(within(bar).getByText('2 flows · 1 / 4 seen · notes by the author')).toBeTruthy();
  });

  it('an inferred tour says so', async () => {
    await open({ ...baseTour, source: 'inferred' });
    expect(screen.getByText(/notes inferred by Claude$/)).toBeTruthy();
  });
});

describe('About: code check', () => {
  const analysis: NonNullable<Tour['analysis']> = {
    engine: 'go-syntax',
    ms: 10,
    degraded: true,
    coverage: { functionSteps: 4, anchored: 3, links: 5, proven: 2, foundByCode: 1 },
    problems: ['could not read go.mod'],
    review: { ran: true, ms: 5, changes: [{ what: 'Moved step 2', reason: 'it runs first' }] },
  };

  it('shows coverage, the engine note and the review changes', async () => {
    await open({ ...baseTour, analysis });
    const text = screen.getByRole('region', { name: 'About this PR' }).textContent;
    expect(text).toContain('3 of 4 steps on their function, 2 of 5 links proven');
    expect(text).toContain('The project did not load with types: links are matched by name.');
    expect(text).toContain('could not read go.mod');
    expect(text).toContain('Moved step 2 — it runs first');
  });

  it('shows a pass C problem once, even when both lists hold it', async () => {
    const both = {
      ...analysis,
      problems: ['review failed'],
      review: { ran: false, ms: 1, changes: [], problems: ['review failed'] },
    };
    await open({ ...baseTour, analysis: both });
    const text = screen.getByRole('region', { name: 'About this PR' }).textContent ?? '';
    expect(text.split('review failed')).toHaveLength(2);
  });

  it('shows review problems when only that list has them', async () => {
    const only = {
      ...analysis,
      problems: [],
      review: { ran: false, ms: 1, changes: [], problems: ['review dropped a change'] },
    };
    await open({ ...baseTour, analysis: only });
    expect(screen.getByRole('region', { name: 'About this PR' }).textContent).toContain(
      'review dropped a change',
    );
  });

  it('is left out for a tour without an analysis', async () => {
    await open();
    expect(screen.getByRole('region', { name: 'About this PR' }).textContent).not.toContain(
      'Code check',
    );
  });
});

describe('About this PR', () => {
  it('is open on the first visit to a tour and closed on the next', async () => {
    const first = await open();
    const button = screen.getByRole('button', { name: /About this PR/ });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'About this PR' }).textContent).toContain(
      'Adds early repayment.',
    );
    first.unmount();

    await open();
    expect(
      screen.getByRole('button', { name: /About this PR/ }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();
  });

  it('is remembered per PR', async () => {
    localStorage.setItem('pr-tour:about-seen:acme/loans#41', '1');
    await open();
    expect(screen.getByRole('region', { name: 'About this PR' })).toBeTruthy();
  });

  it('opens and closes on click', async () => {
    await open();
    const button = screen.getByRole('button', { name: /About this PR/ });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByRole('region', { name: 'About this PR' })).toBeTruthy();
  });

  it('closes when the reader moves to another step', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /About this PR/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /About this PR/ }));
    fireEvent.click(outlineItem('Create repayments table'));
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();
  });

  it('closes on a click outside it, not on a click inside it', async () => {
    await open();
    const about = screen.getByRole('region', { name: 'About this PR' });
    fireEvent.mouseDown(within(about).getByText('Adds early repayment.'));
    expect(screen.getByRole('region', { name: 'About this PR' })).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId('code-view'));
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();
  });

  it('Close shuts it', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();
  });

  it('points aria-controls at the panel only while it is shown', async () => {
    await open();
    const button = screen.getByRole('button', { name: /About this PR/ });
    expect(document.getElementById(button.getAttribute('aria-controls')!)).toBeTruthy();
    fireEvent.click(button);
    expect(button.hasAttribute('aria-controls')).toBe(false);
  });

  it('lists check problems', async () => {
    await open({ ...baseTour, check: { problems: ['src/a.ts:3 has two homes'] } });
    const about = screen.getByRole('region', { name: 'About this PR' });
    expect(within(about).getByText('1 check problem')).toBeTruthy();
    expect(within(about).getByText('src/a.ts:3 has two homes')).toBeTruthy();
  });

  it('still works when storage is blocked', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await open();
    expect(screen.getByRole('region', { name: 'About this PR' })).toBeTruthy();
    spy.mockRestore();
  });
});

describe('step header', () => {
  it('a step: trail with flow number and position, title, facts', async () => {
    const tour = structuredClone(baseTour);
    Object.assign(tour.flows[0]!.steps[2]!, {
      risk: 'read-closely',
      riskReason: 'Not in one transaction.',
      sideEffects: [{ kind: 'db-write', label: 'INSERT repayments' }],
      tests: [
        { file: 't.ts', name: 'stores it' },
        { file: 't.ts', name: 'rejects too much' },
      ],
    });
    await open(tour);
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.click(outlineItem('Record the repayment'));

    expect(trail()).toBe('Flow 1 · step 3 of 5');
    expect(screen.getByRole('heading', { level: 2, name: 'Record the repayment' })).toBeTruthy();
    expect(facts()).toEqual(['Read closely', 'writes to DB', '2 tests']);
  });

  it('a changed step without tests says so in its facts', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'j' });
    expect(facts()).toEqual(['no tests cover this step']);
  });

  it('an unchanged step is context', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: ']' });
    expect(trail()).toBe('Flow 2 · step 1 of 2');
    expect(facts()).toEqual(['Unchanged', 'context']);
  });

  it('a step without changed lines is context, never "no tests"', async () => {
    const tour = structuredClone(baseTour);
    tour.flows[0]!.steps[1]!.changed = true;
    await open(tour);
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: 'j' });
    expect(facts()).toEqual(['Unchanged', 'context']);
  });

  it('a foundation and an other item have their own trail', async () => {
    await open();
    expect(trail()).toBe('Foundation · migration');
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: ']' });
    expect(trail()).toBe('Other changes · Tests');
  });

  it('the why note keeps its source label', async () => {
    await open({ ...baseTour, source: 'inferred' });
    expect(screen.getByText('Why · inferred by Claude')).toBeTruthy();
    expect(screen.getByText('Stores repayments.')).toBeTruthy();
  });
});

describe('extras', () => {
  it('why read closely and tests open in place', async () => {
    const tour = structuredClone(baseTour);
    Object.assign(tour.flows[0]!.steps[0]!, {
      risk: 'read-closely',
      riskReason: 'Not in one transaction.',
      tests: [{ file: 't.ts', name: 'stores it' }],
    });
    await open(tour);
    fireEvent.keyDown(window, { key: 'j' });

    expect(screen.queryByText('Not in one transaction.')).toBeNull();
    const why = screen.getByRole('button', { name: 'Why read closely' });
    expect(why.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(why);
    expect(why.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Not in one transaction.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tests (1)' }));
    expect(screen.getByText(/stores it/)).toBeTruthy();
  });

  it('extras close again on the next step', async () => {
    const tour = structuredClone(baseTour);
    tour.flows[0]!.steps[0]!.tests = [{ file: 't.ts', name: 'stores it' }];
    tour.flows[0]!.steps[2]!.tests = [{ file: 't.ts', name: 'records it' }];
    await open(tour);
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.click(screen.getByRole('button', { name: 'Tests (1)' }));
    fireEvent.click(outlineItem('Record the repayment'));
    expect(screen.queryByText('records it')).toBeNull();
  });

  it('the deploy note opens by itself when the change is not compatible', async () => {
    const tour = structuredClone(baseTour);
    tour.foundations[0]!.deployCompat = { ok: false, note: 'Drops a column.' };
    await open(tour);

    expect(
      screen.getByRole('button', { name: 'Deploy compatibility' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText(/Drops a column\./).textContent).toBe(
      'Not compatible: Drops a column.',
    );
    expect(facts()).toContain('not deploy compatible');
  });

  it('a compatible deploy note and the schema stay shut until clicked', async () => {
    const tour = structuredClone(baseTour);
    tour.foundations[0]!.deployCompat = { ok: true, note: 'Additive only.' };
    tour.foundations[0]!.schemaAfter = 'repayments(id uuid pk)';
    await open(tour);

    expect(screen.queryByText(/Additive only\./)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Deploy compatibility' }));
    expect(screen.getByText(/Additive only\./).textContent).toBe('Compatible: Additive only.');
    fireEvent.click(screen.getByRole('button', { name: 'Schema after' }));
    expect(screen.getByText('repayments(id uuid pk)')).toBeTruthy();
  });
});

describe('extras: aria-controls', () => {
  it('points at the opened detail only while it is shown', async () => {
    const tour = structuredClone(baseTour);
    tour.foundations[0]!.schemaAfter = 'repayments(id uuid pk)';
    await open(tour);
    const link = screen.getByRole('button', { name: 'Schema after' });
    expect(link.hasAttribute('aria-controls')).toBe(false);
    fireEvent.click(link);
    expect(document.getElementById(link.getAttribute('aria-controls')!)!.textContent).toBe(
      'repayments(id uuid pk)',
    );
  });
});

describe('bottom bar', () => {
  it('shows the step buttons and the key hints', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next step' }).className).toContain('primary');
    expect(screen.getByText('j / k steps · [ ] flows · n / p changes · f whole file')).toBeTruthy();
  });
});

const HEAD = 'b'.repeat(40);

function reviewThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
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
        body: 'Index?',
        createdAt: '2026-10-28T09:00:00Z',
        url: 'https://github.com/acme/loans/pull/42#discussion_c1',
      },
    ],
    ...overrides,
  };
}

function reviewDraft(id: number, path = 'm.sql', line = 3, headSha = HEAD): Draft {
  return {
    id,
    kind: 'comment',
    path,
    side: 'new',
    startLine: line,
    endLine: line,
    placement: 'line',
    quote: 'x',
    headSha,
    body: `Draft ${id}`,
    createdAt: '2026-10-28T10:00:00Z',
  };
}

function serveReview(overrides: Partial<ReviewResponse> = {}) {
  getReview.mockResolvedValue({
    viewerIsAuthor: false,
    headSha: HEAD,
    threads: [],
    drafts: [],
    ci: { state: 'none', failing: null },
    ...overrides,
  });
}

const reviewButton = () => screen.getByRole('button', { name: /^Review/ });

/** jsdom has no matchMedia: answer the column query as a wide or a narrow window would. */
function windowIsWide(wide: boolean) {
  const media = vi.fn((query: string) => ({
    matches: query === REVIEW_COLUMN_QUERY && wide,
    media: query,
  }));
  window.matchMedia = media as unknown as typeof window.matchMedia;
  return media;
}
const reviewPanel = () => screen.queryByRole('region', { name: 'Review' });

describe('Review in the top bar', () => {
  it('shows the draft count and turns primary when there are drafts', async () => {
    serveReview({ drafts: [reviewDraft(1), reviewDraft(2), reviewDraft(3, 'src/a.ts')] });
    await open();
    await vi.waitFor(() => expect(reviewButton().textContent).toBe('Review · 3'));
    expect(reviewButton().classList.contains('primary')).toBe(true);
  });

  it('is a plain "Review" button without drafts', async () => {
    serveReview();
    await open();
    expect(reviewButton().textContent).toBe('Review');
    expect(reviewButton().classList.contains('primary')).toBe(false);
  });

  it('opens the panel, with aria-expanded; Close shuts it', async () => {
    serveReview();
    await open();
    expect(reviewButton().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(reviewButton());
    expect(reviewButton().getAttribute('aria-expanded')).toBe('true');
    const panel = reviewPanel()!;
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(reviewPanel()).toBeNull();
  });

  it('stays open while moving through the tour; the keys keep working', async () => {
    serveReview();
    await open();
    fireEvent.click(reviewButton());
    fireEvent.keyDown(window, { key: 'j' });
    expect(trail()).toBe('Flow 1 · step 1 of 5');
    expect(reviewPanel()).toBeTruthy();
    expect(reviewPanel()).toBeTruthy();
  });

  it('stays open on clicks in the outline, the step bar and the top bar', async () => {
    serveReview();
    await open();
    fireEvent.click(reviewButton());

    const next = screen.getByRole('button', { name: 'Next step' });
    fireEvent.mouseDown(next);
    fireEvent.click(next);
    expect(trail()).toBe('Flow 1 · step 1 of 5');
    expect(reviewPanel()).toBeTruthy();

    const item = outlineItem('Create repayments table');
    fireEvent.mouseDown(item);
    fireEvent.click(item);
    expect(trail()).toBe('Foundation · migration');
    expect(reviewPanel()).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('heading', { level: 1 }));
    expect(reviewPanel()).toBeTruthy();
  });

  it('the open panel gives the tour screen a column for it; closing takes it away', async () => {
    serveReview();
    const { container } = await open();
    const app = container.querySelector('.tour-app')!;
    expect(app.classList.contains('review-open')).toBe(false);
    fireEvent.click(reviewButton());
    expect(app.classList.contains('review-open')).toBe(true);
    fireEvent.click(within(reviewPanel()!).getByRole('button', { name: 'Close' }));
    expect(app.classList.contains('review-open')).toBe(false);
  });

  it('narrow window (overlay): a mousedown in the code area closes it', async () => {
    const media = windowIsWide(false);
    serveReview();
    const { container } = await open();
    fireEvent.click(reviewButton());
    fireEvent.mouseDown(screen.getByTestId('code-view'));
    expect(reviewPanel()).toBeNull();
    expect(container.querySelector('.tour-app')!.classList.contains('review-open')).toBe(false);
    expect(media).toHaveBeenCalledWith(REVIEW_COLUMN_QUERY);
  });

  it('wide window (column): a mousedown in the code area leaves it open', async () => {
    const media = windowIsWide(true);
    serveReview();
    const { container } = await open();
    fireEvent.click(reviewButton());
    fireEvent.mouseDown(screen.getByTestId('code-view'));
    expect(reviewPanel()).toBeTruthy();
    expect(container.querySelector('.tour-app')!.classList.contains('review-open')).toBe(true);
    expect(media).toHaveBeenCalledWith(REVIEW_COLUMN_QUERY);
  });

  it('wide window (column): Close, Esc inside and the Review button still close it', async () => {
    windowIsWide(true);
    serveReview();
    await open();
    fireEvent.click(reviewButton());
    fireEvent.click(within(reviewPanel()!).getByRole('button', { name: 'Close' }));
    expect(reviewPanel()).toBeNull();

    fireEvent.click(reviewButton());
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Summary' }), { key: 'Escape' });
    expect(reviewPanel()).toBeNull();

    fireEvent.click(reviewButton());
    fireEvent.mouseDown(reviewButton());
    fireEvent.click(reviewButton());
    expect(reviewPanel()).toBeNull();
  });

  it('closes on a mousedown in the code area', async () => {
    serveReview();
    await open();
    fireEvent.click(reviewButton());
    fireEvent.mouseDown(screen.getByTestId('code-view'));
    expect(reviewPanel()).toBeNull();
  });

  it('keeps the typed summary and event when closed and opened again', async () => {
    serveReview();
    await open();
    fireEvent.click(reviewButton());
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Half written' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    fireEvent.click(within(reviewPanel()!).getByRole('button', { name: 'Close' }));
    fireEvent.click(reviewButton());
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Summary' }).value).toBe(
      'Half written',
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Request changes' }).checked).toBe(
      true,
    );
  });

  it('typing j in the summary does not move', async () => {
    serveReview();
    await open();
    fireEvent.click(reviewButton());
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Summary' }), { key: 'j' });
    expect(trail()).toBe('Foundation · migration');
  });

  it('closes on a click outside it, not inside it', async () => {
    serveReview();
    await open();
    fireEvent.click(reviewButton());
    fireEvent.mouseDown(within(reviewPanel()!).getByText('No pending comments.'));
    expect(reviewPanel()).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('code-view'));
    expect(reviewPanel()).toBeNull();
  });

  it('Esc closes it only when focus is inside it', async () => {
    serveReview();
    await open();
    fireEvent.click(reviewButton());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(reviewPanel()).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Summary' }), { key: 'Escape' });
    expect(reviewPanel()).toBeNull();
    expect(document.activeElement).toBe(reviewButton());
  });

  it('a draft in the panel opens its home', async () => {
    serveReview({ drafts: [reviewDraft(1, 'src/a.ts', 5)] });
    await open();
    await vi.waitFor(() => expect(reviewButton().textContent).toBe('Review · 1'));
    fireEvent.click(reviewButton());
    fireEvent.click(within(reviewPanel()!).getByRole('button', { name: 'src/a.ts:5' }));
    expect(trail()).toBe('Flow 1 · step 1 of 5');
    expect(reviewPanel()).toBeTruthy();
  });

  it('a thread no home owns opens its file at the line', async () => {
    serveReview({ threads: [reviewThread({ path: 'lib/other.ts', line: 8 })] });
    await open();
    fireEvent.click(reviewButton());
    fireEvent.click(await within(reviewPanel()!).findByRole('button', { name: 'lib/other.ts:8' }));
    expect(screen.getByText('lib/other.ts')).toBeTruthy();
    expect(screen.getByText(/Showing/).textContent).toContain('line 8');
  });
});

describe('step header: review counts', () => {
  it("counts the threads and drafts on the home's lines", async () => {
    serveReview({
      threads: [reviewThread(), reviewThread({ id: 'T2', path: 'src/a.ts' })],
      drafts: [reviewDraft(1), reviewDraft(2, 'm.sql', 40)],
    });
    await open();
    await vi.waitFor(() => expect(facts()).toEqual(['1 comment', '1 pending']));
  });

  it('a thread without a line is file-level: not counted for a home', async () => {
    serveReview({ threads: [reviewThread({ line: null, side: null })] });
    await open();
    await vi.waitFor(() => expect(getReview).toHaveBeenCalled());
    await screen.findByRole('button', { name: /^Review/ });
    expect(screen.queryByRole('list', { name: 'Step facts' })).toBeNull();
  });

  it('says "2 comments" for two', async () => {
    serveReview({ threads: [reviewThread(), reviewThread({ id: 'T2', line: 1 })] });
    await open();
    await vi.waitFor(() => expect(facts()).toEqual(['2 comments']));
  });
});

describe('review after a rebuild', () => {
  const NEW_HEAD = 'c'.repeat(40);

  it('labels drafts by the new tour head and reloads the review', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getPr = vi.mocked(api.getPr);
    const buildTour = vi.mocked(api.buildTour);
    getPr.mockResolvedValueOnce(response({ outdated: true })).mockResolvedValueOnce(
      response({
        tour: { ...baseTour, headSha: NEW_HEAD },
        job: { state: 'done', log: ['Saved'] },
      }),
    );
    buildTour.mockResolvedValue({ job: { state: 'running', log: ['Cloning'] } });
    // The first load knows the old head; the reload after the rebuild never answers, so the
    // labels can only come from the tour.
    getReview
      .mockResolvedValueOnce({
        viewerIsAuthor: false,
        headSha: HEAD,
        threads: [],
        drafts: [reviewDraft(1), reviewDraft(2, 'm.sql', 3, NEW_HEAD)],
        ci: { state: 'none', failing: null },
      })
      .mockReturnValue(new Promise(() => {}));
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByText('New commits since this tour was built');
    await vi.waitFor(() => expect(reviewButton().textContent).toBe('Review · 2'));

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild tour' }));
    await screen.findByText('Cloning');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await vi.waitFor(() => expect(screen.queryByText('Cloning')).toBeNull());

    expect(getReview).toHaveBeenCalledTimes(2);
    fireEvent.click(reviewButton());
    const items = within(screen.getByRole('list', { name: 'Pending comments' })).getAllByRole(
      'listitem',
    );
    expect(within(items[0]!).queryByText('older version')).toBeTruthy();
    expect(within(items[1]!).queryByText('older version')).toBeNull();
  });
});

function withFlowWhys(): Tour {
  const tour = structuredClone(baseTour);
  tour.flows[0]!.why = 'The borrower pays early. The new check runs in step 3.';
  tour.flows[1]!.why = 'Tells the lender after a repayment.';
  return tour;
}

function aboutFlowButton() {
  return screen.queryByRole('button', { name: 'About this flow' });
}

function aboutFlowPanel() {
  return screen.queryByRole('region', { name: 'About this flow' });
}

describe('About this PR: how the tour is built', () => {
  it('lists each flow with its why, and a click goes to the flow', async () => {
    await open(withFlowWhys());
    const about = screen.getByRole('region', { name: 'About this PR' });
    expect(within(about).getByRole('heading', { name: 'How the tour is built' })).toBeTruthy();
    const items = within(about)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual([
      '1 Repay a loanThe borrower pays early. The new check runs in step 3.',
      '2 Notify the lenderTells the lender after a repayment.',
    ]);

    fireEvent.click(within(about).getByRole('button', { name: '2 Notify the lender' }));
    expect(trail()).toBe('Flow 2 · step 1 of 2');
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();
  });

  it('is left out for a tour without flow whys', async () => {
    await open();
    const about = screen.getByRole('region', { name: 'About this PR' });
    expect(within(about).queryByText('How the tour is built')).toBeNull();
  });
});

describe('About this flow', () => {
  it('is a button on every step of a flow with a why, and shut until clicked', async () => {
    await open(withFlowWhys());
    expect(aboutFlowButton()).toBeNull(); // the foundation is not in a flow
    fireEvent.keyDown(window, { key: 'j' });
    expect(aboutFlowButton()!.getAttribute('aria-expanded')).toBe('false');
    expect(aboutFlowPanel()).toBeNull();
    fireEvent.keyDown(window, { key: 'j' });
    expect(aboutFlowButton()).toBeTruthy();
  });

  it('opens the flow title, entry and why; a second click shuts it', async () => {
    await open(withFlowWhys());
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.click(aboutFlowButton()!);
    const panel = aboutFlowPanel()!;
    expect(panel.textContent).toContain('Repay a loan');
    expect(panel.textContent).toContain('POST /F1');
    expect(panel.textContent).toContain('The borrower pays early. The new check runs in step 3.');
    expect(aboutFlowButton()!.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(aboutFlowButton()!.getAttribute('aria-controls')!)).toBe(panel);

    fireEvent.click(aboutFlowButton()!);
    expect(aboutFlowPanel()).toBeNull();
  });

  it('closes on a click outside it, on Esc and on the next step', async () => {
    await open(withFlowWhys());
    fireEvent.keyDown(window, { key: 'j' });

    fireEvent.click(aboutFlowButton()!);
    fireEvent.mouseDown(aboutFlowPanel()!);
    expect(aboutFlowPanel()).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('code-view'));
    expect(aboutFlowPanel()).toBeNull();

    fireEvent.click(aboutFlowButton()!);
    fireEvent.keyDown(aboutFlowPanel()!, { key: 'Escape' });
    expect(aboutFlowPanel()).toBeNull();
    expect(document.activeElement).toBe(aboutFlowButton());

    fireEvent.keyDown(aboutFlowButton()!, { key: 'Escape' });
    expect(aboutFlowPanel()).toBeNull();

    fireEvent.click(aboutFlowButton()!);
    fireEvent.keyDown(window, { key: 'j' });
    expect(aboutFlowPanel()).toBeNull();
  });

  it('closes when the page scrolls or resizes, not when the popover itself scrolls', async () => {
    await open(withFlowWhys());
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.click(aboutFlowButton()!);
    fireEvent.scroll(aboutFlowPanel()!);
    expect(aboutFlowPanel()).toBeTruthy();
    fireEvent.scroll(screen.getByTestId('code-view'));
    expect(aboutFlowPanel()).toBeNull();

    fireEvent.click(aboutFlowButton()!);
    fireEvent(window, new Event('resize'));
    expect(aboutFlowPanel()).toBeNull();
  });

  it('Esc with the popover shut leaves the tour keys alone', async () => {
    await open(withFlowWhys());
    fireEvent.keyDown(window, { key: 'j' });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stop = vi.spyOn(event, 'stopPropagation');
    aboutFlowButton()!.dispatchEvent(event);
    expect(stop).not.toHaveBeenCalled();
  });

  it('is left out for a flow without a why', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'j' });
    expect(aboutFlowButton()).toBeNull();
  });

  it('leaves the trail text as it was', async () => {
    await open(withFlowWhys());
    fireEvent.keyDown(window, { key: 'j' });
    expect(trail()).toBe('Flow 1 · step 1 of 5');
  });
});
