import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, PrResponse, PrSummary } from '../../src/shared/api.js';
import type { OtherGroup, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';

vi.mock('../../src/web/api.js', () => ({
  getPr: vi.fn(),
  buildTour: vi.fn(),
  markSeen: vi.fn(),
}));

// The real code view loads files from the server; these tests are about the tour around it.
vi.mock('../../src/web/CodeView.js', () => ({
  CodeView: ({ file, homeId }: { file: string; homeId: string }) => (
    <div data-testid="code-view">{`${homeId} ${file}`}</div>
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

function outline(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Tour outline' });
}

/** The outline entry for the item with this title. */
function outlineItem(title: string): HTMLElement {
  return within(outline()).getByRole('button', { name: new RegExp(title) });
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
    expect(buildTour).toHaveBeenCalledWith('acme/loans', 42);
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

  it('outline order is foundations, flows, other', async () => {
    const tour = withGroups(makeTour(), group('unexplained', 'u1', 'src/misc.ts lines 3–4'));
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    const headings = within(outline())
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Foundations', 'Flows', 'Other changes']);

    const items = within(outline())
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    const order = [
      'Create repayments table',
      'Validate and record the repayment',
      'src/misc.ts lines 3–4',
      'Repay tests',
    ].map((title) => items.findIndex((text) => text.includes(title)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
  });

  it('pressing j marks the current step seen and moves on', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);

    const first = await screen.findByRole('button', { name: /Create repayments table/ });
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
    expect(buildTour).toHaveBeenCalledWith('acme/loans', 42);
    // The old tour stays readable while the new one builds.
    expect(outline()).toBeTruthy();
  });

  it('inferred tour labels notes as inferred', async () => {
    getPr.mockResolvedValue(response({ tour: makeTour({ source: 'inferred' }) }));
    render(<TourView repo="acme/loans" pr={42} />);

    expect(await screen.findByText('Notes inferred by Claude')).toBeTruthy();
    expect(screen.getByText(/Why · inferred by Claude/)).toBeTruthy();
    expect(screen.queryByText('Notes by the author')).toBeNull();
  });

  it('a changed step without tests warns that no tests cover it', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);

    fireEvent.click(await screen.findByRole('button', { name: /Validate and record/ }));

    expect(screen.getByText('no tests cover this step')).toBeTruthy();
    expect(screen.getByText('Check and insert are not in one transaction.')).toBeTruthy();
  });
  it('j and k follow the outline order: unexplained changes come before other groups', async () => {
    const tour = withGroups(makeTour(), group('unexplained', 'u1', 'Unexplained lines'));
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    fireEvent.click(await screen.findByRole('button', { name: /Validate and record/ }));
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

  it('generated and refactor groups start collapsed and expand on click', async () => {
    const tour = withGroups(
      makeTour(),
      group('generated', 'g1', 'Lockfile'),
      group('refactor', 'r1', 'Rename helper'),
    );
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    await screen.findByRole('navigation', { name: 'Tour outline' });
    expect(within(outline()).getByText('skim only')).toBeTruthy();
    expect(within(outline()).getByText('Summary of the refactor group.')).toBeTruthy();
    expect(within(outline()).queryByText('Lockfile')).toBeNull();
    expect(within(outline()).queryByText('Rename helper')).toBeNull();

    const toggle = within(outline()).getByRole('button', { name: /refactor group/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(outline()).getByText('Rename helper')).toBeTruthy();
    expect(within(outline()).queryByText('Lockfile')).toBeNull();
  });

  it('collapsing a group hides it even when the current item is inside', async () => {
    const tour = withGroups(makeTour(), group('generated', 'g1', 'Lockfile'));
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    fireEvent.click(await screen.findByRole('button', { name: /Repay tests/ }));
    fireEvent.keyDown(window, { key: 'j' });
    const toggle = within(outline()).getByRole('button', { name: /generated group/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(outlineItem('Lockfile').getAttribute('aria-current')).toBe('step');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(outline()).queryByText('Lockfile')).toBeNull();
  });

  it('check problems are listed under the outline', async () => {
    const tour = makeTour({ check: { problems: ['src/a.ts:3 has two homes: F1.S1, o1.1'] } });
    getPr.mockResolvedValue(response({ tour }));
    render(<TourView repo="acme/loans" pr={42} />);

    expect(await screen.findByText('1 check problem')).toBeTruthy();
    expect(screen.getByText('src/a.ts:3 has two homes: F1.S1, o1.1')).toBeTruthy();
  });

  it('a foundation shows its schema after and deploy compatibility', async () => {
    getPr.mockResolvedValue(response());
    render(<TourView repo="acme/loans" pr={42} />);

    expect(await screen.findByText('repayments(id uuid pk, amount_cents bigint)')).toBeTruthy();
    expect(screen.getByText(/Additive only\./).textContent).toBe('Compatible: Additive only.');
  });
});
