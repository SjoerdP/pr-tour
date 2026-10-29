import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, PrResponse, PrSummary } from '../../src/shared/api.js';
import type { OtherGroup, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';
import { outline, outlineItem } from './outline-helpers.js';

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
    onJump,
    onOpenHome,
    review,
  }: {
    file: string;
    focus: { start: number } | null;
    homeId: string;
    plain?: boolean;
    onJump: (file: string, line: number) => void;
    onOpenHome: (homeId: string) => void;
    review?: { state: string };
  }) => (
    <div>
      <div data-testid="code-view" data-plain={plain ? 'yes' : 'no'}>{`${homeId} ${file}`}</div>
      <div data-testid="code-review">{review?.state ?? 'none'}</div>
      <div data-testid="code-focus">{focus?.start}</div>
      <button type="button" onClick={() => onJump('src/fees.ts', 12)}>
        follow chargeFee
      </button>
      <button type="button" onClick={() => onOpenHome('o1.1')}>
        open o1.1
      </button>
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

    fireEvent.click(screen.getByRole('button', { name: 'open o1.1' }));
    expect(outlineItem('Repay tests').getAttribute('aria-current')).toBe('step');
    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'f1', 'h-f1');
  });
});
