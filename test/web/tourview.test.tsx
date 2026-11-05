import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, PrResponse, PrSummary } from '../../src/shared/api.js';
import type { OtherGroup, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';
import { placeMapBoxes, scrolled } from './map-scroll.js';
import { outline, outlineItem } from './outline-helpers.js';
import { startTour } from './overview-helpers.js';

vi.mock('../../src/web/api.js', async (importActual) => ({
  ApiError: (await importActual<typeof import('../../src/web/api.js')>()).ApiError,
  getPr: vi.fn(),
  buildTour: vi.fn(),
  markSeen: vi.fn(),
  // The tour view loads the PR's review; these tests are not about it: it never arrives.
  getReview: () => new Promise(() => {}),
}));

// The real code view loads files from the server; these tests are about the tour around it.
// It shows which file and focus it was given, and offers its two ways out of the step.
vi.mock('../../src/web/CodeView.js', () => ({
  CodeView: ({
    file,
    focus,
    homeId,
    plain,
    reveal,
    onJump,
    onOpenHome,
    onNextStep,
    review,
    keys,
  }: {
    file: string;
    focus: { start: number } | null;
    homeId: string;
    plain?: boolean;
    reveal?: { at: unknown } | null;
    onJump: (file: string, line: number, toStep?: string | null) => void;
    onOpenHome: (homeId: string) => void;
    onNextStep?: () => void;
    review?: { state: string };
    keys?: boolean;
  }) => (
    <div>
      <div
        data-testid="code-view"
        data-plain={plain ? 'yes' : 'no'}
        // Whether this code view answers n / p / f (CodeView's default is yes).
        data-keys={keys === false ? 'no' : 'yes'}
        data-reveal={reveal ? JSON.stringify(reveal.at) : undefined}
      >{`${homeId} ${file}`}</div>
      <div data-testid="code-review">{review?.state ?? 'none'}</div>
      <div data-testid="code-focus">{focus?.start}</div>
      <button type="button" onClick={() => onJump('src/fees.ts', 12)}>
        follow chargeFee
      </button>
      <button type="button" onClick={() => onJump('src/fees.ts', 12, 'F1.S2')}>
        site to step
      </button>
      <button type="button" onClick={() => onJump('src/fees.ts', 12, null)}>
        site to nothing
      </button>
      <button type="button" onClick={() => onOpenHome('o1.1')}>
        open o1.1
      </button>
      {onNextStep && (
        <button type="button" onClick={onNextStep}>
          next step marker
        </button>
      )}
    </div>
  ),
}));

const getPr = vi.mocked(api.getPr);
const buildTour = vi.mocked(api.buildTour);
const markSeen = vi.mocked(api.markSeen);

const summary: PrSummary = {
  repo: 'acme/loans',
  number: 42,
  title: 'Early repayment',
  author: 'alice',
  url: 'https://github.com/acme/loans/pull/42',
  additions: 120,
  deletions: 8,
  isDraft: false,
  updatedAt: '2026-10-27T12:00:00Z',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  viewerIsAuthor: false,
};

function makeTour(overrides: Partial<Tour> = {}): Tour {
  return {
    repo: 'acme/loans',
    pr: 42,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    source: 'author',
    createdAt: '2026-10-27T12:00:00Z',
    summary: 'Adds early repayment of loans.',
    foundations: [
      {
        id: 'f1',
        kind: 'migration',
        title: 'Create repayments table',
        file: 'migrations/0042_repayments.sql',
        why: 'Stores each repayment.',
        risk: 'read-closely',
        homes: [{ file: 'migrations/0042_repayments.sql', side: 'new', start: 1, end: 12 }],
        schemaAfter: 'repayments(id uuid pk, amount_cents bigint)',
        deployCompat: { ok: true, note: 'Additive only.' },
      },
    ],
    flows: [
      {
        id: 'F1',
        title: 'Repay a loan',
        entry: { kind: 'http', label: 'POST /loans/{id}/repay' },
        steps: [
          {
            id: 'F1.S1',
            title: 'Validate and record the repayment',
            file: 'src/loans/repay.ts',
            startLine: 10,
            endLine: 41,
            changed: true,
            why: 'Rejects amounts above the balance.',
            risk: 'read-closely',
            riskReason: 'Check and insert are not in one transaction.',
            sideEffects: [{ kind: 'db-write', label: 'INSERT repayments' }],
            tests: [],
            calls: [],
            homes: [{ file: 'src/loans/repay.ts', side: 'new', start: 10, end: 41 }],
          },
        ],
      },
    ],
    other: [
      {
        kind: 'tests',
        title: 'Tests',
        summary: 'Tests for the repay endpoint.',
        items: [
          {
            id: 'o1.1',
            file: 'test/loans/repay.test.ts',
            title: 'Repay tests',
            homes: [{ file: 'test/loans/repay.test.ts', side: 'new', start: 1, end: 60 }],
          },
        ],
      },
    ],
    check: { problems: [] },
    hashes: { f1: 'h-f1', 'F1.S1': 'h-s1', 'o1.1': 'h-o1' },
    ...overrides,
  };
}

function response(overrides: Partial<PrResponse> = {}): PrResponse {
  return { pr: summary, tour: makeTour(), seen: {}, outdated: false, job: null, ...overrides };
}

function job(state: Job['state'], log: string[], error?: string): Job {
  return error === undefined ? { state, log } : { state, log, error };
}

/** A one-item other-changes group; its item's file is its title. */
function group(kind: OtherGroup['kind'], id: string, title: string): OtherGroup {
  return {
    kind,
    title: `${kind} group`,
    summary: `Summary of the ${kind} group.`,
    items: [{ id, file: `src/${id}.ts`, title, homes: [] }],
  };
}

/** `tour` with these groups added after its own other changes (and hashes for their items). */
function withGroups(tour: Tour, ...groups: OtherGroup[]): Tour {
  const hashes = { ...tour.hashes };
  for (const g of groups) for (const item of g.items) hashes[item.id] = `h-${item.id}`;
  return { ...tour, other: [...tour.other, ...groups], hashes };
}

beforeEach(() => {
  markSeen.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('TourView', () => {
  it('no tour shows Build tour and starts a build', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPr
      .mockResolvedValueOnce(response({ tour: null }))
      .mockResolvedValueOnce(
        response({ tour: null, job: job('running', ['Cloning', 'Asking Claude']) }),
      )
      .mockResolvedValueOnce(response({ job: job('done', ['Cloning', 'Asking Claude', 'Saved']) }));
    buildTour.mockResolvedValue({ job: job('running', ['Cloning']) });
    render(<TourView repo="acme/loans" pr={42} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Build tour' }));
    expect(buildTour).toHaveBeenCalledWith('acme/loans', 42, false);
    expect(await screen.findByText('Cloning')).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(await screen.findByText('Asking Claude')).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(await screen.findByRole('navigation', { name: 'Tour outline' })).toBeTruthy();
    expect(getPr).toHaveBeenCalledTimes(3);

    // The build is over: no more polling.
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(getPr).toHaveBeenCalledTimes(3);
  });

  it('failed build shows the error and Try again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPr
      .mockResolvedValueOnce(response({ tour: null }))
      .mockResolvedValueOnce(
        response({ tour: null, job: job('failed', ['Asking Claude'], 'Claude returned no JSON') }),
      );
    buildTour.mockResolvedValue({ job: job('running', ['Cloning']) });
    render(<TourView repo="acme/loans" pr={42} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Build tour' }));
    await screen.findByText('Cloning');
    await act(() => vi.advanceTimersByTimeAsync(2000));

    expect((await screen.findByRole('alert')).textContent).toContain('Claude returned no JSON');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(buildTour).toHaveBeenCalledTimes(2);
  });

  it('passes the PR review down to the code view', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);
    await startTour();

    // The review never arrives in these tests: the code view gets it while it loads.
    expect((await screen.findByTestId('code-review')).textContent).toBe('loading');
  });

  it('outline order is foundations, flows, other', async () => {
    const tour = withGroups(makeTour(), group('unexplained', 'u1', 'src/misc.ts lines 3–4'));
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    const headings = within(outline())
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Foundations', 'Flows', 'Other changes']);

    const items = [
      'Create repayments table',
      'Validate and record the repayment',
      'src/misc.ts lines 3–4',
      'Repay tests',
    ].map(outlineItem);
    for (const [a, b] of items.slice(0, -1).map((a, i) => [a, items[i + 1]!] as const)) {
      expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('pressing j marks the current step seen and moves on', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    await startTour();
    const first = outlineItem('Create repayments table');
    expect(first.getAttribute('aria-current')).toBe('step');
    expect(within(first).queryByLabelText('seen')).toBeNull();
    expect(markSeen).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'j' });

    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'f1', 'h-f1');
    expect(within(outlineItem('Create repayments table')).getByLabelText('seen')).toBeTruthy();
    const second = outlineItem('Validate and record the repayment');
    expect(second.getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('code-view').textContent).toBe('F1.S1 src/loans/repay.ts');
  });

  it('pressing j on the last item marks it seen and stays there', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Repay tests'));
    fireEvent.keyDown(window, { key: 'j' });

    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'o1.1', 'h-o1');
    const last = outlineItem('Repay tests');
    expect(within(last).getByLabelText('seen')).toBeTruthy();
    expect(last.getAttribute('aria-current')).toBe('step');
  });

  it('a seen mark with an old hash does not count as seen', async () => {
    getPr.mockResolvedValue(response({ seen: { f1: 'old-hash', 'F1.S1': 'h-s1' } }));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    expect(within(outlineItem('Create repayments table')).queryByLabelText('seen')).toBeNull();
    expect(
      within(outlineItem('Validate and record the repayment')).getByLabelText('seen'),
    ).toBeTruthy();
  });

  it('a failed seen mark shows an error and navigation goes on', async () => {
    markSeen.mockRejectedValue(new Error('Server is down'));
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    await startTour();
    fireEvent.click(outlineItem('Repay tests'));

    expect((await screen.findByRole('status')).textContent).toContain('Server is down');
    expect(outlineItem('Repay tests').getAttribute('aria-current')).toBe('step');
    expect(within(outlineItem('Create repayments table')).queryByLabelText('seen')).toBeNull();
  });

  it('keys typed into a text field do not navigate', async () => {
    getPr.mockResolvedValue(response());
    render(
      <>
        <input aria-label="note" />
        <TourView repo="acme/loans" pr={42} />
      </>,
    );

    await screen.findByRole('navigation', { name: 'Tour outline' });
    await startTour();
    fireEvent.keyDown(screen.getByLabelText('note'), { key: 'j' });

    expect(outlineItem('Create repayments table').getAttribute('aria-current')).toBe('step');
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('outdated shows the banner', async () => {
    getPr.mockResolvedValue(response({ outdated: true }));
    buildTour.mockResolvedValue({ job: job('running', []) });
    render(<TourView repo="acme/loans" pr={42} />);

    const banner = await screen.findByText('New commits since this tour was built');
    expect(banner).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild tour' }));
    expect(buildTour).toHaveBeenCalledWith('acme/loans', 42, false);
    // The old tour stays readable while the new one builds.
    expect(outline()).toBeTruthy();
  });

  it('409 shows inline confirm; Rebuild re-posts with replace', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    getPr.mockResolvedValue(response({ outdated: true }));
    buildTour
      .mockRejectedValueOnce(new api.ApiError(409, 'This PR has 2 unsent drafts.', undefined, 2))
      .mockResolvedValueOnce({ job: job('running', ['Cloning']) });
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByText('New commits since this tour was built');
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild tour' }));

    expect(await screen.findByText('You have 2 unsent drafts. Rebuild anyway?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));

    expect(buildTour).toHaveBeenLastCalledWith('acme/loans', 42, true);
    expect(await screen.findByText('Cloning')).toBeTruthy();
    expect(screen.queryByText(/Rebuild anyway/)).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('Rebuild tour is off while the replace confirm shows', async () => {
    getPr.mockResolvedValue(response({ outdated: true }));
    buildTour.mockRejectedValueOnce(
      new api.ApiError(409, 'This PR has 1 unsent draft.', undefined, 1),
    );
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByText('New commits since this tour was built');
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild tour' }));
    await screen.findByText('You have 1 unsent draft. Rebuild anyway?');

    const rebuild = screen.getByRole<HTMLButtonElement>('button', { name: 'Rebuild tour' });
    expect(rebuild.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(rebuild.disabled).toBe(false);
  });

  it('Cancel on the replace confirm builds nothing', async () => {
    getPr.mockResolvedValue(response({ outdated: true }));
    buildTour.mockRejectedValueOnce(
      new api.ApiError(409, 'This PR has 1 unsent draft.', undefined, 1),
    );
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByText('New commits since this tour was built');
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild tour' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText(/Rebuild anyway/)).toBeNull();
    expect(buildTour).toHaveBeenCalledTimes(1);
    expect(outline()).toBeTruthy();
  });

  it('inferred tour labels notes as inferred', async () => {
    getPr.mockResolvedValue(response({ tour: makeTour({ source: 'inferred' }) }));
    render(<TourView repo="acme/loans" pr={42} />);
    await startTour();

    expect(await screen.findByText(/notes inferred by Claude$/)).toBeTruthy();
    expect(screen.getByText(/Why · inferred by Claude/)).toBeTruthy();
    expect(screen.queryByText(/notes by the author/)).toBeNull();
  });

  it('a changed step without tests warns that no tests cover it', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Validate and record'));

    expect(screen.getByText('no tests cover this step')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Why read closely' }));
    expect(screen.getByText('Check and insert are not in one transaction.')).toBeTruthy();
  });
  it('j and k follow the outline order: unexplained changes come before other groups', async () => {
    const tour = withGroups(makeTour(), group('unexplained', 'u1', 'Unexplained lines'));
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Validate and record'));
    fireEvent.keyDown(window, { key: 'j' });
    expect(outlineItem('Unexplained lines').getAttribute('aria-current')).toBe('step');

    fireEvent.keyDown(window, { key: 'j' });
    expect(outlineItem('Repay tests').getAttribute('aria-current')).toBe('step');

    fireEvent.keyDown(window, { key: 'k' });
    expect(outlineItem('Unexplained lines').getAttribute('aria-current')).toBe('step');
  });

  it('polling stops when the page goes away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPr.mockResolvedValue(response({ tour: null, job: job('running', ['Cloning']) }));
    const { unmount } = render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByText('Cloning');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(getPr).toHaveBeenCalledTimes(2);

    unmount();
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(getPr).toHaveBeenCalledTimes(2);
  });

  it('a failed status check keeps the log and checks again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPr
      .mockResolvedValueOnce(response({ tour: null, job: job('running', ['Cloning']) }))
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(response({ job: job('done', ['Cloning', 'Saved']) }));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByText('Cloning');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect((await screen.findByRole('status')).textContent).toBe(
      "Couldn't check the build status: Failed to fetch",
    );
    expect(screen.getByText('Cloning')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(await screen.findByRole('navigation', { name: 'Tour outline' })).toBeTruthy();
  });

  it('status checks that keep failing end the wait with Try again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPr
      .mockResolvedValueOnce(response({ tour: null, job: job('running', ['Cloning']) }))
      .mockRejectedValue(new Error('Failed to fetch'));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByText('Cloning');
    await act(() => vi.advanceTimersByTimeAsync(2000 * 3));

    expect((await screen.findByRole('alert')).textContent).toContain(
      "Couldn't check the build status: Failed to fetch",
    );
    expect(screen.getByText('Cloning')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    const calls = getPr.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(getPr).toHaveBeenCalledTimes(calls);
  });

  it('groups start collapsed and expand on click to their summary and items', async () => {
    const tour = withGroups(
      makeTour(),
      group('generated', 'g1', 'Lockfile'),
      group('refactor', 'r1', 'Rename helper'),
    );
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    expect(within(outline()).getByText('skim')).toBeTruthy();
    expect(within(outline()).queryByText('Summary of the refactor group.')).toBeNull();
    expect(within(outline()).queryByText('Repay tests')).toBeNull();
    expect(within(outline()).queryByText('Lockfile')).toBeNull();
    expect(within(outline()).queryByText('Rename helper')).toBeNull();

    const toggle = within(outline()).getByRole('button', { name: /refactor group/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(outline()).getByText('Rename helper')).toBeTruthy();
    expect(within(outline()).getByText('Summary of the refactor group.')).toBeTruthy();
    expect(within(outline()).queryByText('Lockfile')).toBeNull();
  });

  it('generated code is shown without highlighting, other code with it', async () => {
    const tour = withGroups(makeTour(), group('generated', 'g1', 'Lockfile'));
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Repay tests'));
    expect(screen.getByTestId('code-view').dataset.plain).toBe('no');

    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByTestId('code-view').textContent).toBe('g1 src/g1.ts');
    expect(screen.getByTestId('code-view').dataset.plain).toBe('yes');
  });

  it('collapsing a group hides it even when the current item is inside', async () => {
    const tour = withGroups(makeTour(), group('generated', 'g1', 'Lockfile'));
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Repay tests'));
    fireEvent.keyDown(window, { key: 'j' });
    const toggle = within(outline()).getByRole('button', { name: /generated group/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(outlineItem('Lockfile').getAttribute('aria-current')).toBe('step');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(outline()).queryByText('Lockfile')).toBeNull();
  });

  it('check problems are listed in About this PR', async () => {
    const tour = makeTour({ check: { problems: ['src/a.ts:3 has two homes: F1.S1, o1.1'] } });
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    expect(await screen.findByText('1 check problem')).toBeTruthy();
    expect(screen.getByText('src/a.ts:3 has two homes: F1.S1, o1.1')).toBeTruthy();
  });

  it('a foundation shows its schema after and deploy compatibility', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    await startTour();
    fireEvent.click(screen.getByRole('button', { name: 'Schema after' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deploy compatibility' }));
    expect(screen.getByText('repayments(id uuid pk, amount_cents bigint)')).toBeTruthy();
    expect(screen.getByText(/Additive only\./).textContent).toBe('Compatible: Additive only.');
  });

  it('following a traced call shows that file without marking the step seen', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Validate and record'));
    markSeen.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'follow chargeFee' }));
    expect(screen.getByTestId('code-view').textContent).toBe('F1.S1 src/fees.ts');
    expect(screen.getByTestId('code-focus').textContent).toBe('12');
    expect(markSeen).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Back to this step' }).title).toBe(
      'Back to this step (Esc)',
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('code-view').textContent).toBe('F1.S1 src/loans/repay.ts');
    expect(screen.getByTestId('code-focus').textContent).toBe('10');
  });

  it('following a call into a step of the same flow goes to that step', async () => {
    const tour = makeTour();
    const flow = tour.flows[0]!;
    const charge = {
      ...flow.steps[0]!,
      id: 'F1.S2',
      title: 'Charge the fee',
      file: 'src/fees.ts',
      startLine: 12,
      endLine: 30,
      homes: [{ file: 'src/fees.ts', side: 'new' as const, start: 12, end: 30 }],
    };
    getPr.mockResolvedValue(
      response({
        tour: {
          ...tour,
          flows: [{ ...flow, steps: [...flow.steps, charge] }],
          hashes: { ...tour.hashes, 'F1.S2': 'h-s2' },
        },
      }),
    );
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Validate and record'));

    fireEvent.click(screen.getByRole('button', { name: 'follow chargeFee' }));
    expect(outlineItem('Charge the fee').getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('code-view').textContent).toBe('F1.S2 src/fees.ts');
    expect(screen.queryByRole('button', { name: 'Back to this step' })).toBeNull();
    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'F1.S1', 'h-s1');
  });

  it('focuses the anchor of a checked step, the step lines otherwise', async () => {
    const tour = makeTour();
    tour.flows[0]!.steps[0]!.anchor = {
      name: 'repay',
      startLine: 12,
      endLine: 30,
      source: 'symbol',
    };
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Validate and record'));
    expect(screen.getByTestId('code-focus').textContent).toBe('12');
  });

  it('a call site goes to its step; one without a step opens a quick look', async () => {
    const tour = makeTour();
    const flow = tour.flows[0]!;
    // The step is not at the call's line: only its id says where to go.
    const charge = { ...flow.steps[0]!, id: 'F1.S2', title: 'Charge the fee', file: 'src/x.ts' };
    getPr.mockResolvedValue(
      response({
        tour: {
          ...tour,
          flows: [{ ...flow, steps: [...flow.steps, charge] }],
          hashes: { ...tour.hashes, 'F1.S2': 'h-s2' },
        },
      }),
    );
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Validate and record'));

    fireEvent.click(screen.getByRole('button', { name: 'site to nothing' }));
    expect(screen.getByTestId('code-view').textContent).toBe('F1.S1 src/fees.ts');
    expect(screen.getByRole('button', { name: 'Back to this step' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to this step' }));

    fireEvent.click(screen.getByRole('button', { name: 'site to step' }));
    expect(screen.getByTestId('code-view').textContent).toBe('F1.S2 src/x.ts');
  });

  it('a call into a step of another flow stays a look from this step', async () => {
    const tour = makeTour();
    const flow = tour.flows[0]!;
    const other = {
      ...flow,
      id: 'F2',
      title: 'Charge fees',
      steps: [
        {
          ...flow.steps[0]!,
          id: 'F2.S1',
          title: 'Charge the fee',
          file: 'src/fees.ts',
          startLine: 12,
          endLine: 30,
          homes: [{ file: 'src/fees.ts', side: 'new' as const, start: 12, end: 30 }],
        },
      ],
    };
    getPr.mockResolvedValue(
      response({
        tour: { ...tour, flows: [flow, other], hashes: { ...tour.hashes, 'F2.S1': 'h-f2' } },
      }),
    );
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Validate and record'));

    fireEvent.click(screen.getByRole('button', { name: 'follow chargeFee' }));
    expect(outlineItem('Validate and record').getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('code-view').textContent).toBe('F1.S1 src/fees.ts');
    expect(screen.getByRole('button', { name: 'Back to this step' })).toBeTruthy();
  });

  it('a belongs-to label in the code opens that item', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });
    await startTour();

    fireEvent.click(screen.getByRole('button', { name: 'open o1.1' }));
    expect(outlineItem('Repay tests').getAttribute('aria-current')).toBe('step');
    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'f1', 'h-f1');
  });

  it("the code's next-step marker goes to the next step; a quick look has none", async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem('Validate and record'));

    fireEvent.click(screen.getByRole('button', { name: 'follow chargeFee' }));
    expect(screen.queryByRole('button', { name: 'next step marker' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to this step' }));

    fireEvent.click(screen.getByRole('button', { name: 'next step marker' }));
    expect(outlineItem('Repay tests').getAttribute('aria-current')).toBe('step');
  });
});

describe('flow map', () => {
  /** The tour's flow with three linked steps: S1 calls S2 on line 15, S2 calls S3 on line 20. */
  function threeSteps(): Tour {
    const tour = makeTour();
    const flow = tour.flows[0]!;
    const first = flow.steps[0]!;
    const at = (id: string, title: string, file: string) => ({
      ...first,
      id,
      title,
      file,
      homes: [{ file, side: 'new' as const, start: 1, end: 30 }],
    });
    return {
      ...tour,
      flows: [
        {
          ...flow,
          steps: [
            first,
            at('F1.S2', 'Charge the fee', 'src/fees.ts'),
            at('F1.S3', 'Post to the ledger', 'src/ledger/post.ts'),
          ],
          links: [
            { from: 'F1.S1', to: 'F1.S2', line: 15, how: 'call', source: 'both', check: 'proven' },
            { from: 'F1.S2', to: 'F1.S3', line: 20, how: 'call', source: 'both', check: 'proven' },
          ],
        },
      ],
      hashes: { ...tour.hashes, 'F1.S2': 'h-s2', 'F1.S3': 'h-s3' },
    };
  }

  async function showStep(title: string) {
    getPr.mockResolvedValue(response({ tour: threeSteps() }));
    render(
      <>
        <textarea aria-label="note" />
        <TourView repo="acme/loans" pr={42} />
      </>,
    );
    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(outlineItem(title));
  }

  const map = () => screen.queryByRole('dialog', { name: 'Flow map: Repay a loan' });

  it('the Flow map button and m open the map of the current flow', async () => {
    await showStep('Validate and record');

    fireEvent.click(screen.getByRole('button', { name: 'Flow map' }));
    expect(map()).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(map()).toBeNull();
    fireEvent.keyDown(window, { key: 'm' });
    expect(map()).toBeTruthy();
    fireEvent.click(within(map()!).getByRole('button', { name: 'Close' }));
    expect(map()).toBeNull();
  });

  it('opening the map moves focus into it; closing puts focus back on the button', async () => {
    await showStep('Validate and record');
    const button = screen.getByRole('button', { name: 'Flow map' });

    fireEvent.click(button);
    expect(map()!.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(map());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(map()).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.keyDown(window, { key: 'm' });
    expect(document.activeElement).toBe(map());
    fireEvent.click(within(map()!).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(button);

    fireEvent.keyDown(window, { key: 'm' });
    fireEvent.keyDown(document.activeElement!, { key: 'm' });
    expect(map()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  /** The peek in the map panel or the overview: a region named by the peeked step's title. */
  const peekOf = (title: string) => screen.queryByRole('region', { name: title });
  /** The step pane's own code view (a peek has one too). */
  const paneCode = () => within(screen.getByRole('article')).getByTestId('code-view');
  const openInTour = () =>
    fireEvent.click(within(map()!).getByRole('button', { name: 'Open in tour' }));

  it('Open in tour from a box goes to that step and closes the map', async () => {
    await showStep('Validate and record');
    fireEvent.keyDown(window, { key: 'm' });

    fireEvent.click(within(map()!).getByRole('button', { name: /Step 3/ }));
    openInTour();
    expect(screen.getByTestId('step-trail').textContent).toContain('step 3 of 3');
    expect(map()).toBeNull();
  });

  it('Open in tour from an arrow opens the calling step at the calling line', async () => {
    await showStep('Post to the ledger');
    fireEvent.keyDown(window, { key: 'm' });

    fireEvent.click(within(map()!).getByRole('button', { name: /^line 20/ }));
    openInTour();
    expect(screen.getByTestId('step-trail').textContent).toContain('step 2 of 3');
    expect(map()).toBeNull();
    expect(paneCode().getAttribute('data-reveal')).toBe(
      JSON.stringify({ path: 'src/fees.ts', side: 'new', line: 20 }),
    );
  });

  it('the map closes when the reader moves to a foundation', async () => {
    await showStep('Validate and record');
    fireEvent.keyDown(window, { key: 'm' });
    expect(map()).toBeTruthy();

    fireEvent.click(outlineItem('Create repayments table'));
    expect(map()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Flow map' })).toBeNull();
    fireEvent.keyDown(window, { key: 'm' });
    expect(map()).toBeNull();
  });

  it('Escape closes the map before it goes back from a followed call', async () => {
    await showStep('Validate and record');
    // A call site without a step: a look from this step.
    fireEvent.click(screen.getByRole('button', { name: 'site to nothing' }));
    expect(screen.getByRole('button', { name: 'Back to this step' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'm' });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(map()).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to this step' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Back to this step' })).toBeNull();
  });

  it('the map closes when a rebuild swaps in a new tour', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rebuilt = { ...threeSteps(), headSha: 'c'.repeat(40), createdAt: '2026-10-28T12:00:00Z' };
    getPr
      .mockResolvedValueOnce(response({ tour: threeSteps(), outdated: true }))
      .mockResolvedValue(response({ tour: rebuilt, job: job('done', ['Saved']) }));
    buildTour.mockResolvedValue({ job: job('running', ['Cloning']) });
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });
    // A started tour: after the rebuild it opens on the first home not seen, the step.
    await startTour();
    fireEvent.click(outlineItem('Validate and record'));
    fireEvent.keyDown(window, { key: 'm' });
    expect(map()).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild tour' }));
    await screen.findByText('Cloning');
    await act(() => vi.advanceTimersByTimeAsync(2000));

    expect(screen.getByTestId('code-view').textContent).toContain('F1.S1');
    expect(map()).toBeNull();
    // Still a step: m opens the map of the new tour.
    fireEvent.keyDown(window, { key: 'm' });
    expect(map()).toBeTruthy();
  });

  it('m in a text field types and does not open the map', async () => {
    await showStep('Validate and record');

    fireEvent.keyDown(screen.getByLabelText('note'), { key: 'm' });
    expect(map()).toBeNull();
  });

  describe('peek and visits', () => {
    const trail = () => screen.getByTestId('step-trail').textContent;
    const back = (to: string) => screen.queryByRole('button', { name: `Back to the ${to}` });
    const box = (no: number) =>
      fireEvent.click(within(map()!).getByRole('button', { name: new RegExp(`Step ${no}`) }));
    const peekTrail = () => within(map()!).getByTestId('peek-trail').textContent;

    it('a box click in the map panel opens a peek and leaves the tour where it was', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });

      box(2);
      expect(peekOf('Charge the fee')).toBeTruthy();
      expect(map()).toBeTruthy();
      expect(trail()).toContain('step 1 of 3');
      expect(paneCode().textContent).toBe('F1.S1 src/loans/repay.ts');
      expect(outlineItem('Validate and record').getAttribute('aria-current')).toBe('step');
      expect(markSeen).not.toHaveBeenCalled();
    });

    it('j and k move the peek, not the tour, and stop at the ends', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });

      // No peek yet: j peeks at the step the tour is on.
      fireEvent.keyDown(window, { key: 'j' });
      expect(peekTrail()).toContain('step 1 of 3');
      fireEvent.keyDown(window, { key: 'j' });
      expect(peekTrail()).toContain('step 2 of 3');
      fireEvent.keyDown(window, { key: 'j' });
      fireEvent.keyDown(window, { key: 'j' });
      expect(peekTrail()).toContain('step 3 of 3');
      fireEvent.keyDown(window, { key: 'k' });
      fireEvent.keyDown(window, { key: 'k' });
      fireEvent.keyDown(window, { key: 'k' });
      expect(peekTrail()).toContain('step 1 of 3');

      expect(map()).toBeTruthy();
      expect(trail()).toContain('step 1 of 3');
      expect(paneCode().textContent).toBe('F1.S1 src/loans/repay.ts');
      expect(markSeen).not.toHaveBeenCalled();
    });

    it('k with no peek also peeks at the step the tour is on', async () => {
      await showStep('Charge the fee');
      fireEvent.keyDown(window, { key: 'm' });

      fireEvent.keyDown(window, { key: 'k' });
      expect(peekTrail()).toContain('step 2 of 3');
      expect(trail()).toContain('step 2 of 3');
      expect(markSeen).not.toHaveBeenCalled();
    });

    it('Esc closes the peek, a second Esc closes the map', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });
      box(2);

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(peekOf('Charge the fee')).toBeNull();
      expect(map()).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(map()).toBeNull();
      expect(trail()).toContain('step 1 of 3');

      // The map opens again without the old peek.
      fireEvent.keyDown(window, { key: 'm' });
      expect(peekOf('Charge the fee')).toBeNull();
      expect(markSeen).not.toHaveBeenCalled();

      // A peek closed from inside it leaves focus on the map, not lost.
      box(2);
      const close = within(peekOf('Charge the fee')!).getByRole('button', { name: 'Close' });
      close.focus();
      fireEvent.click(close);
      expect(peekOf('Charge the fee')).toBeNull();
      expect(document.activeElement).toBe(map());
    });

    it('Mark as seen marks the peeked step without moving the tour', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });
      box(2);

      fireEvent.click(within(map()!).getByRole('button', { name: 'Mark as seen' }));
      expect(markSeen).toHaveBeenCalledTimes(1);
      expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'F1.S2', 'h-s2');
      expect(within(map()!).queryByRole('button', { name: 'Mark as seen' })).toBeNull();
      expect(map()).toBeTruthy();
      expect(peekOf('Charge the fee')).toBeTruthy();
      expect(trail()).toContain('step 1 of 3');
      expect(outlineItem('Validate and record').getAttribute('aria-current')).toBe('step');
    });

    it('Open in tour visits the step; Back returns to the map with the same peek and the old place, marking nothing', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });
      box(2);
      const peek = peekOf('Charge the fee');

      openInTour();
      expect(map()).toBeNull();
      expect(trail()).toContain('step 2 of 3');
      expect(paneCode().textContent).toBe('F1.S2 src/fees.ts');
      expect(outlineItem('Charge the fee').getAttribute('aria-current')).toBe('step');
      expect(document.activeElement).toBe(screen.getByRole('article'));
      expect(back('overview')).toBeNull();

      fireEvent.click(back('map')!);
      expect(map()).toBeTruthy();
      // The same peek, kept while the map was hidden.
      expect(peekOf('Charge the fee')).toBe(peek);
      expect(trail()).toContain('step 1 of 3');
      expect(paneCode().textContent).toBe('F1.S1 src/loans/repay.ts');
      expect(outlineItem('Validate and record').getAttribute('aria-current')).toBe('step');
      expect(back('map')).toBeNull();
      expect(markSeen).not.toHaveBeenCalled();

      // Esc goes back too, once nothing else uses it.
      openInTour();
      expect(trail()).toContain('step 2 of 3');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(map()).toBeTruthy();
      expect(trail()).toContain('step 1 of 3');
      expect(markSeen).not.toHaveBeenCalled();
    });

    it('Back scrolls the map to the peeked box again', async () => {
      const place = placeMapBoxes();
      try {
        await showStep('Validate and record');
        fireEvent.keyDown(window, { key: 'm' });
        box(2);
        const flowMap = map()!.querySelector('.flow-map')!;
        expect(scrolled(flowMap)).toEqual({ left: 650, top: 520 });

        openInTour();
        // The browser may lose the scroll of a hidden map.
        flowMap.scrollLeft = 0;
        flowMap.scrollTop = 0;
        fireEvent.click(back('map')!);
        expect(map()!.querySelector('.flow-map')).toBe(flowMap);
        expect(scrolled(flowMap)).toEqual({ left: 650, top: 520 });
        expect(place.scrollIntoView).not.toHaveBeenCalled();
        expect(markSeen).not.toHaveBeenCalled();
      } finally {
        place.restore();
      }
    });

    it('moving on from a visited step ends the visit and marks it when left', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });
      box(2);
      openInTour();

      fireEvent.keyDown(window, { key: 'j' });
      expect(trail()).toContain('step 3 of 3');
      expect(back('map')).toBeNull();
      expect(map()).toBeNull();
      expect(markSeen).toHaveBeenCalledTimes(1);
      expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'F1.S2', 'h-s2');
      // No visit left to go back from.
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(trail()).toContain('step 3 of 3');
      expect(map()).toBeNull();
    });

    it('an outline click also ends the visit', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });
      box(3);
      openInTour();

      fireEvent.click(outlineItem('Create repayments table'));
      expect(back('map')).toBeNull();
      expect(markSeen).toHaveBeenCalledTimes(1);
      expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'F1.S3', 'h-s3');
    });

    it('] also ends the visit', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });
      box(2);
      openInTour();

      fireEvent.keyDown(window, { key: ']' });
      expect(paneCode().textContent).toBe('o1.1 test/loans/repay.test.ts');
      expect(back('map')).toBeNull();
      expect(markSeen).toHaveBeenCalledTimes(1);
      expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'F1.S2', 'h-s2');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(paneCode().textContent).toBe('o1.1 test/loans/repay.test.ts');
      expect(map()).toBeNull();
    });

    it('during a visit, Esc first goes back from a followed call, then goes Back', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });
      box(2);
      openInTour();
      fireEvent.click(
        within(screen.getByRole('article')).getByRole('button', {
          name: 'site to nothing',
        }),
      );
      expect(screen.getByRole('button', { name: 'Back to this step' })).toBeTruthy();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('button', { name: 'Back to this step' })).toBeNull();
      expect(trail()).toContain('step 2 of 3');
      expect(back('map')).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(map()).toBeTruthy();
      expect(trail()).toContain('step 1 of 3');
      expect(markSeen).not.toHaveBeenCalled();
    });

    it('m during a visit from the map shows the same peek again', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });
      fireEvent.click(within(map()!).getByRole('button', { name: /^line 15/ }));
      const peek = peekOf('Validate and record the repayment');
      expect(peek).toBeTruthy();
      openInTour();
      expect(trail()).toContain('step 1 of 3');

      fireEvent.keyDown(window, { key: 'm' });
      expect(peekOf('Validate and record the repayment')).toBe(peek);
      // The map's own Close (the first; the peek has one too) keeps the peek for Back.
      fireEvent.click(within(map()!).getAllByRole('button', { name: 'Close' })[0]!);
      expect(map()).toBeNull();
      fireEvent.click(back('map')!);
      expect(peekOf('Validate and record the repayment')).toBe(peek);
      expect(markSeen).not.toHaveBeenCalled();
    });

    it('a rebuild during a visit ends the visit and drops the peek', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const rebuilt = {
        ...threeSteps(),
        headSha: 'c'.repeat(40),
        createdAt: '2026-10-28T12:00:00Z',
      };
      getPr
        .mockResolvedValueOnce(response({ tour: threeSteps(), outdated: true }))
        .mockResolvedValue(response({ tour: rebuilt, job: job('done', ['Saved']) }));
      buildTour.mockResolvedValue({ job: job('running', ['Cloning']) });
      render(<TourView repo="acme/loans" pr={42} />);
      await screen.findByRole('navigation', { name: 'Tour outline' });
      await startTour();
      fireEvent.click(outlineItem('Validate and record'));
      fireEvent.keyDown(window, { key: 'm' });
      box(2);
      openInTour();
      expect(back('map')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Rebuild tour' }));
      await screen.findByText('Cloning');
      await act(() => vi.advanceTimersByTimeAsync(2000));

      expect(back('map')).toBeNull();
      expect(screen.queryByRole('dialog', { hidden: true, name: /^Flow map/ })).toBeNull();
      fireEvent.keyDown(window, { key: 'm' });
      expect(map()).toBeTruthy();
      expect(peekOf('Charge the fee')).toBeNull();
    });

    it('a second Open in tour during a visit still returns to the place before the first visit', async () => {
      await showStep('Validate and record');
      fireEvent.keyDown(window, { key: 'm' });
      box(2);
      openInTour();
      expect(trail()).toContain('step 2 of 3');

      fireEvent.keyDown(window, { key: 'm' });
      box(3);
      openInTour();
      expect(trail()).toContain('step 3 of 3');

      fireEvent.click(back('map')!);
      expect(trail()).toContain('step 1 of 3');
      expect(map()).toBeTruthy();
      // The map comes back with the latest peek.
      expect(peekOf('Post to the ledger')).toBeTruthy();
      expect(peekOf('Charge the fee')).toBeNull();
      expect(markSeen).not.toHaveBeenCalled();
    });

    it('n acts on the peek, not on the step pane under the map', async () => {
      await showStep('Validate and record');
      expect(paneCode().getAttribute('data-keys')).toBe('yes');

      fireEvent.keyDown(window, { key: 'm' });
      expect(paneCode().getAttribute('data-keys')).toBe('no');
      box(2);
      const peekCode = within(peekOf('Charge the fee')!).getByTestId('code-view');
      expect(peekCode.getAttribute('data-keys')).toBe('yes');
      expect(paneCode().getAttribute('data-keys')).toBe('no');

      // During a visit the hidden peek takes no keys; the visited step does.
      openInTour();
      expect(paneCode().getAttribute('data-keys')).toBe('yes');
      const all = screen.getAllByTestId('code-view');
      expect(all.filter((c) => c.getAttribute('data-keys') === 'yes')).toEqual([paneCode()]);

      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(map()).toBeNull();
      expect(paneCode().getAttribute('data-keys')).toBe('yes');
    });

    describe('on the overview', () => {
      /** threeSteps with a second flow of one step. */
      function twoFlows(): Tour {
        const tour = threeSteps();
        const first = tour.flows[0]!;
        const notify = {
          ...first.steps[0]!,
          id: 'F2.S1',
          title: 'Tell the lender',
          file: 'src/notify.ts',
          homes: [{ file: 'src/notify.ts', side: 'new' as const, start: 1, end: 9 }],
        };
        return {
          ...tour,
          flows: [
            first,
            {
              id: 'F2',
              title: 'Notify the lender',
              entry: { kind: 'event', label: 'loan.repaid' },
              steps: [notify],
            },
          ],
          hashes: { ...tour.hashes, 'F2.S1': 'h-n1' },
        };
      }

      async function load() {
        getPr.mockResolvedValue(response({ tour: twoFlows() }));
        render(<TourView repo="acme/loans" pr={42} />);
        await screen.findByRole('navigation', { name: 'Tour outline' });
      }

      const overview = () => screen.queryByRole('region', { name: 'Overview' });
      const card = (name: string) => screen.getByRole('region', { name });

      const cardBox = (name: string, no: number) =>
        fireEvent.click(within(card(name)).getByRole('button', { name: new RegExp(`Step ${no}`) }));

      it('a strip click is a visit with Back to the overview', async () => {
        await load();
        fireEvent.click(screen.getByRole('button', { name: 'Show the map of flow 2' }));
        cardBox('Flow 1 · Repay a loan', 2);
        const peek = peekOf('Charge the fee');
        expect(peek).toBeTruthy();

        const strip = within(card('Flow 1 · Repay a loan')).getByRole('list', { name: 'Steps' });
        fireEvent.click(within(strip).getByRole('button', { name: /Post to the ledger/ }));
        expect(overview()).toBeNull();
        expect(trail()).toContain('step 3 of 3');
        expect(document.activeElement).toBe(screen.getByRole('article'));
        expect(back('map')).toBeNull();

        fireEvent.click(back('overview')!);
        expect(overview()).toBeTruthy();
        expect(document.activeElement).toBe(overview());
        // As it was: flow 2's map still open, the same peek in flow 1.
        expect(screen.getByRole('region', { name: 'Flow 2 map' })).toBeTruthy();
        expect(peekOf('Charge the fee')).toBe(peek);
        expect(markSeen).not.toHaveBeenCalled();
        fireEvent.click(screen.getAllByRole('button', { name: 'Start the tour' })[0]!);
        expect(paneCode().textContent).toBe('f1 migrations/0042_repayments.sql');
        expect(markSeen).not.toHaveBeenCalled();
      });

      it('Back to the overview scrolls the card map to the peeked box again', async () => {
        const place = placeMapBoxes();
        try {
          await load();
          cardBox('Flow 1 · Repay a loan', 2);
          const flowMap = card('Flow 1 map').querySelector('.flow-map')!;
          expect(scrolled(flowMap)).toEqual({ left: 650, top: 520 });

          fireEvent.click(
            within(peekOf('Charge the fee')!).getByRole('button', { name: 'Open in tour' }),
          );
          flowMap.scrollLeft = 0;
          flowMap.scrollTop = 0;
          fireEvent.click(back('overview')!);
          expect(card('Flow 1 map').querySelector('.flow-map')).toBe(flowMap);
          expect(scrolled(flowMap)).toEqual({ left: 650, top: 520 });
          expect(markSeen).not.toHaveBeenCalled();
        } finally {
          place.restore();
        }
      });

      it('Also in this PR and Open in tour are visits too', async () => {
        await load();
        fireEvent.click(screen.getByRole('button', { name: 'Tests (1)' }));
        expect(paneCode().textContent).toBe('o1.1 test/loans/repay.test.ts');
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(overview()).toBeTruthy();

        cardBox('Flow 1 · Repay a loan', 2);
        fireEvent.click(
          within(peekOf('Charge the fee')!).getByRole('button', { name: 'Open in tour' }),
        );
        expect(paneCode().textContent).toBe('F1.S2 src/fees.ts');
        fireEvent.click(back('overview')!);
        expect(peekOf('Charge the fee')).toBeTruthy();
        expect(markSeen).not.toHaveBeenCalled();
      });

      it('opening a peek in one card closes the peek in another', async () => {
        await load();
        fireEvent.click(screen.getByRole('button', { name: 'Show the map of flow 2' }));
        cardBox('Flow 1 · Repay a loan', 2);
        expect(peekOf('Charge the fee')).toBeTruthy();

        cardBox('Flow 2 · Notify the lender', 1);
        expect(peekOf('Tell the lender')).toBeTruthy();
        expect(peekOf('Charge the fee')).toBeNull();
      });

      it("hiding a card's map drops its peek: j and Esc act as with no peek", async () => {
        await load();
        cardBox('Flow 1 · Repay a loan', 2);
        expect(peekOf('Charge the fee')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Hide the map of flow 1' }));

        // Esc closes the overview at once: there is no hidden peek to close first.
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(overview()).toBeNull();
        // A fresh overview: flow 1's map open again, with no peek.
        fireEvent.keyDown(window, { key: 'o' });
        expect(screen.getByRole('region', { name: 'Flow 1 map' })).toBeTruthy();
        expect(peekOf('Charge the fee')).toBeNull();

        cardBox('Flow 1 · Repay a loan', 2);
        fireEvent.click(screen.getByRole('button', { name: 'Hide the map of flow 1' }));
        fireEvent.keyDown(window, { key: 'j' });
        expect(overview()).toBeNull();
        expect(paneCode().textContent).toBe('f1 migrations/0042_repayments.sql');
        expect(markSeen).not.toHaveBeenCalled();
      });

      it('Back to a card whose map was hidden meanwhile brings no unseen peek', async () => {
        await load();
        cardBox('Flow 1 · Repay a loan', 2);
        fireEvent.click(
          within(peekOf('Charge the fee')!).getByRole('button', { name: 'Open in tour' }),
        );
        fireEvent.keyDown(window, { key: 'o' });
        fireEvent.click(screen.getByRole('button', { name: 'Hide the map of flow 1' }));
        fireEvent.keyDown(window, { key: 'o' });
        fireEvent.click(back('overview')!);
        expect(overview()).toBeTruthy();
        expect(screen.queryByRole('region', { name: 'Flow 1 map' })).toBeNull();

        // No hidden peek takes the keys: Esc closes the overview at once.
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(overview()).toBeNull();
        expect(paneCode().textContent).toBe('f1 migrations/0042_repayments.sql');
        expect(markSeen).not.toHaveBeenCalled();
      });

      it('Hide the map leaves focus on its button', async () => {
        await load();
        cardBox('Flow 1 · Repay a loan', 2);
        const toggle = screen.getByRole('button', { name: 'Hide the map of flow 1' });
        toggle.focus();
        fireEvent.click(toggle);
        expect(peekOf('Charge the fee')).toBeNull();
        expect(document.activeElement).toBe(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
      });

      it('a card peek closed from inside it leaves focus on the overview', async () => {
        await load();
        cardBox('Flow 1 · Repay a loan', 2);
        const close = within(peekOf('Charge the fee')!).getByRole('button', { name: 'Close' });
        close.focus();
        fireEvent.click(close);
        expect(peekOf('Charge the fee')).toBeNull();
        expect(document.activeElement).toBe(overview());
      });

      it('hiding another card keeps the peek', async () => {
        await load();
        fireEvent.click(screen.getByRole('button', { name: 'Show the map of flow 2' }));
        cardBox('Flow 1 · Repay a loan', 2);
        fireEvent.click(screen.getByRole('button', { name: 'Hide the map of flow 2' }));
        expect(peekOf('Charge the fee')).toBeTruthy();
      });

      it('o during a visit from the overview shows the same peek again', async () => {
        await load();
        cardBox('Flow 1 · Repay a loan', 2);
        const peek = peekOf('Charge the fee');
        fireEvent.click(within(peek!).getByRole('button', { name: 'Open in tour' }));
        expect(overview()).toBeNull();

        fireEvent.keyDown(window, { key: 'o' });
        expect(overview()).toBeTruthy();
        expect(peekOf('Charge the fee')).toBe(peek);
        fireEvent.keyDown(window, { key: 'o' });
        fireEvent.click(back('overview')!);
        expect(peekOf('Charge the fee')).toBe(peek);
        expect(markSeen).not.toHaveBeenCalled();
      });

      it('j and k move the peek on the overview; without a peek they close it', async () => {
        await load();
        cardBox('Flow 1 · Repay a loan', 1);
        fireEvent.keyDown(window, { key: 'j' });
        expect(peekOf('Charge the fee')).toBeTruthy();
        expect(overview()).toBeTruthy();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(peekOf('Charge the fee')).toBeNull();
        expect(overview()).toBeTruthy();
        fireEvent.keyDown(window, { key: 'j' });
        expect(overview()).toBeNull();
        expect(paneCode().textContent).toBe('f1 migrations/0042_repayments.sql');
        expect(markSeen).not.toHaveBeenCalled();
      });
    });
  });
});

describe('overview', () => {
  const overview = () => screen.queryByRole('heading', { level: 2, name: 'Early repayment' });
  const trail = () => screen.queryByTestId('step-trail');
  const codeView = () => screen.getByTestId('code-view').textContent;
  // The overview has the start button at its top and its end: the first of them.
  const startButton = (name: string) => screen.getAllByRole('button', { name })[0]!;

  async function load(overrides: Partial<PrResponse> = {}) {
    getPr.mockResolvedValue(response(overrides));
    render(
      <>
        <input aria-label="note" />
        <TourView repo="acme/loans" pr={42} />
      </>,
    );
    await screen.findByRole('navigation', { name: 'Tour outline' });
  }

  it('a PR the reader has not started opens on the overview', async () => {
    await load();
    expect(overview()).toBeTruthy();
    expect(startButton('Start the tour')).toBeTruthy();
    expect(trail()).toBeNull();
    expect(screen.queryByTestId('code-view')).toBeNull();
  });

  it('seen marks that are all outdated still open on the overview', async () => {
    await load({ seen: { f1: 'old-hash', 'F1.S1': 'old-hash' } });
    expect(overview()).toBeTruthy();
    expect(startButton('Start the tour')).toBeTruthy();
    expect(trail()).toBeNull();
  });

  it('Start the tour shows the first home', async () => {
    await load();
    fireEvent.click(startButton('Start the tour'));
    expect(overview()).toBeNull();
    expect(trail()).toBeTruthy();
    expect(codeView()).toBe('f1 migrations/0042_repayments.sql');
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('a started PR opens on the first home not seen', async () => {
    await load({ seen: { f1: 'h-f1', 'F1.S1': 'h-s1' } });
    expect(overview()).toBeNull();
    expect(trail()).toBeTruthy();
    expect(codeView()).toBe('o1.1 test/loans/repay.test.ts');
  });

  it('everything seen opens on the first home', async () => {
    await load({ seen: { f1: 'h-f1', 'F1.S1': 'h-s1', 'o1.1': 'h-o1' } });
    expect(overview()).toBeNull();
    expect(codeView()).toBe('f1 migrations/0042_repayments.sql');
  });

  it('the Overview button and o open the overview; Start goes back to where the reader was', async () => {
    await load();
    fireEvent.click(startButton('Start the tour'));
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'j' });
    expect(codeView()).toBe('o1.1 test/loans/repay.test.ts');

    const button = screen.getByRole('button', { name: 'Overview' });
    expect(button.title).toBe('Overview (o)');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(window, { key: 'o' });
    expect(overview()).toBeTruthy();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(startButton('Continue the tour'));
    expect(overview()).toBeNull();
    expect(codeView()).toBe('o1.1 test/loans/repay.test.ts');

    fireEvent.click(button);
    expect(overview()).toBeTruthy();
    fireEvent.click(button);
    expect(overview()).toBeNull();
    expect(codeView()).toBe('o1.1 test/loans/repay.test.ts');
  });

  it('o toggles the overview and Escape closes it', async () => {
    await load();
    fireEvent.keyDown(window, { key: 'o' });
    expect(overview()).toBeNull();
    fireEvent.keyDown(window, { key: 'o' });
    expect(overview()).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(overview()).toBeNull();
    expect(codeView()).toBe('f1 migrations/0042_repayments.sql');
  });

  it('j on the overview shows the current home without moving', async () => {
    await load();
    fireEvent.click(startButton('Start the tour'));
    fireEvent.keyDown(window, { key: 'j' });
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
    fireEvent.keyDown(window, { key: 'o' });

    fireEvent.keyDown(window, { key: 'j' });
    expect(overview()).toBeNull();
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
    expect(markSeen).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.keyDown(window, { key: 'k' });
    expect(overview()).toBeNull();
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
  });

  it('] on the overview opens the next flow without marking a home seen', async () => {
    await load();
    fireEvent.keyDown(window, { key: ']' });
    expect(overview()).toBeNull();
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('[ and ] at the ends of the tour still close the overview, without moving', async () => {
    // No other changes: the flow is the end of the tour.
    await load({ tour: makeTour({ other: [] }) });
    fireEvent.click(startButton('Start the tour'));
    fireEvent.keyDown(window, { key: 'j' });
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
    expect(markSeen).toHaveBeenCalledTimes(1);

    // The tour is in the last flow: there is no next flow.
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.keyDown(window, { key: ']' });
    expect(overview()).toBeNull();
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');

    // On the first home there is no previous flow.
    fireEvent.keyDown(window, { key: 'k' });
    expect(codeView()).toBe('f1 migrations/0042_repayments.sql');
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.keyDown(window, { key: '[' });
    expect(overview()).toBeNull();
    expect(codeView()).toBe('f1 migrations/0042_repayments.sql');
    // Only j and k marked a home: the ones they left.
    expect(markSeen).toHaveBeenCalledTimes(2);
  });

  it('leaving the overview mid-tour does not mark the home the tour is on', async () => {
    await load();
    fireEvent.click(startButton('Start the tour'));
    fireEvent.keyDown(window, { key: 'j' });
    expect(markSeen).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'o' });

    fireEvent.click(outlineItem('Repay tests'));
    expect(codeView()).toBe('o1.1 test/loans/repay.test.ts');
    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(markSeen).not.toHaveBeenCalledWith('acme/loans', 42, 'F1.S1', 'h-s1');
  });

  it('an outline click closes the overview and opens that home', async () => {
    await load();
    fireEvent.click(outlineItem('Repay tests'));
    expect(overview()).toBeNull();
    expect(codeView()).toBe('o1.1 test/loans/repay.test.ts');
    // The reader never read the first home: leaving the overview does not mark it seen.
    expect(markSeen).not.toHaveBeenCalled();

    // Also the home the tour is already on.
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.click(outlineItem('Repay tests'));
    expect(overview()).toBeNull();
    expect(codeView()).toBe('o1.1 test/loans/repay.test.ts');
  });

  it('a step in the overview opens that step, also the one the tour is on', async () => {
    await load();
    let strip = screen.getByRole('list', { name: 'Steps' });
    fireEvent.click(within(strip).getByRole('button', { name: /Validate and record/ }));
    expect(overview()).toBeNull();
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
    expect(markSeen).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'o' });
    strip = screen.getByRole('list', { name: 'Steps' });
    fireEvent.click(within(strip).getByRole('button', { name: /Validate and record/ }));
    expect(overview()).toBeNull();
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
    expect(outlineItem('Validate and record').getAttribute('aria-current')).toBe('step');
  });

  it('opening the overview closes the flow map', async () => {
    await load();
    fireEvent.click(startButton('Start the tour'));
    fireEvent.keyDown(window, { key: 'j' });
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
    fireEvent.keyDown(window, { key: 'm' });
    const map = () => screen.queryByRole('dialog', { name: 'Flow map: Repay a loan' });
    expect(map()).toBeTruthy();

    fireEvent.keyDown(window, { key: 'o' });
    expect(overview()).toBeTruthy();
    expect(map()).toBeNull();
    // m does not open the step's map over the overview.
    fireEvent.keyDown(window, { key: 'm' });
    expect(map()).toBeNull();
    fireEvent.click(startButton('Continue the tour'));
    expect(map()).toBeNull();
  });

  it('the opening place is taken once: Continue goes back to the home the tour is on', async () => {
    await load();
    fireEvent.click(startButton('Start the tour'));
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'k' });
    // Every home is seen now: a fresh opening place would be the first home.
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');

    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.click(startButton('Continue the tour'));
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
  });

  it('a poll that returns the same tour moves neither the home nor the overview', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const seen = { f1: 'h-f1', 'F1.S1': 'h-s1', 'o1.1': 'h-o1' };
    getPr
      .mockResolvedValueOnce(response({ outdated: true }))
      .mockResolvedValue(response({ seen, job: job('done', ['Saved']) }));
    buildTour.mockResolvedValue({ job: job('running', ['Cloning']) });
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });
    fireEvent.click(startButton('Start the tour'));
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'k' });
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
    fireEvent.keyDown(window, { key: 'o' });
    expect(overview()).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild tour' }));
    await screen.findByText('Cloning');
    await act(() => vi.advanceTimersByTimeAsync(2000));

    expect(getPr).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Cloning')).toBeNull();
    expect(overview()).toBeTruthy();
    fireEvent.click(startButton('Continue the tour'));
    expect(codeView()).toBe('F1.S1 src/loans/repay.ts');
  });

  it('opening the overview moves focus into it; leaving it moves focus to the step', async () => {
    await load();
    const region = () => screen.getByRole('region', { name: 'Overview' });
    const step = () => screen.getByRole('article');
    // Opening on the overview at load does not take focus.
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(startButton('Start the tour'));
    expect(document.activeElement).toBe(step());
    fireEvent.keyDown(window, { key: 'o' });
    expect(document.activeElement).toBe(region());
    fireEvent.keyDown(window, { key: 'j' });
    expect(document.activeElement).toBe(step());
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.keyDown(window, { key: 'o' });
    expect(document.activeElement).toBe(step());

    const button = screen.getByRole('button', { name: 'Overview' });
    fireEvent.click(button);
    expect(document.activeElement).toBe(region());
    fireEvent.keyDown(window, { key: 'k' });
    expect(document.activeElement).toBe(step());
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(step());

    // Opening a home from the overview focuses that home's step.
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.click(outlineItem('Repay tests'));
    expect(step().getAttribute('aria-labelledby')).toBe('step-title-o1.1');
    expect(document.activeElement).toBe(step());
    fireEvent.keyDown(window, { key: 'o' });
    const strip = screen.getByRole('list', { name: 'Steps' });
    fireEvent.click(within(strip).getByRole('button', { name: /Validate and record/ }));
    expect(document.activeElement).toBe(step());
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.keyDown(window, { key: '[' });
    expect(step().getAttribute('aria-labelledby')).toBe('step-title-f1');
    expect(document.activeElement).toBe(step());
  });

  it('a rebuild that leaves the overview does not take focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rebuilt = { ...makeTour(), headSha: 'c'.repeat(40), createdAt: '2026-10-28T12:00:00Z' };
    getPr
      .mockResolvedValueOnce(response({ outdated: true }))
      .mockResolvedValue(response({ tour: rebuilt, seen: { f1: 'h-f1' }, job: job('done', []) }));
    buildTour.mockResolvedValue({ job: job('running', ['Cloning']) });
    render(
      <>
        <input aria-label="note" />
        <TourView repo="acme/loans" pr={42} />
      </>,
    );
    await screen.findByRole('navigation', { name: 'Tour outline' });
    expect(overview()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild tour' }));
    await screen.findByText('Cloning');
    const note = screen.getByLabelText('note');
    note.focus();

    await act(() => vi.advanceTimersByTimeAsync(2000));
    // Started on the new tour: it opens on a home, not the overview.
    expect(overview()).toBeNull();
    expect(document.activeElement).toBe(note);
  });

  it('o in a text field types and does not open the overview', async () => {
    await load();
    fireEvent.click(startButton('Start the tour'));
    fireEvent.keyDown(screen.getByLabelText('note'), { key: 'o' });
    expect(overview()).toBeNull();
  });
});
