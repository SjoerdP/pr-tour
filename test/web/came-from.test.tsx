import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrResponse } from '../../src/shared/api.js';
import type { FlowLink, Mark, Step, StepFrom, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';
import { cameFromRows } from './came-from-helpers.js';
import { outlineItem } from './outline-helpers.js';

vi.mock('../../src/web/api.js', async (importActual) => ({
  ApiError: (await importActual<typeof import('../../src/web/api.js')>()).ApiError,
  getPr: vi.fn(),
  buildTour: vi.fn(),
  markSeen: vi.fn(),
  getReview: () => new Promise(() => {}),
}));

// The code view only says which file and line it shows.
vi.mock('../../src/web/CodeView.js', () => ({
  CodeView: ({
    file,
    focus,
    reveal,
  }: {
    file: string;
    focus: { start: number } | null;
    reveal: { at: { line: number | null } | 'focus' } | null;
  }) => (
    <div data-testid="code-view" data-reveal={reveal && JSON.stringify(reveal.at)}>
      {`${file}:${focus?.start}`}
    </div>
  ),
}));

const getPr = vi.mocked(api.getPr);
const markSeen = vi.mocked(api.markSeen);

function step(
  n: number,
  title: string,
  file: string,
  [startLine, endLine]: [number, number],
  from?: StepFrom,
): Step {
  return {
    id: `F1.S${n}`,
    title,
    file,
    startLine,
    endLine,
    changed: false,
    why: `${title}.`,
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    ...(from && { from }),
    homes: [],
  };
}

/**
 * The example: one flow, "Repay a loan", that shows every way the flow can get to a step.
 *
 *   1. Handle the repay request    POST /loans/{id}/repay comes in (the entry: no "from").
 *   2. Check the amount            step 1 calls validateRepayment() on line 12.
 *   3. Record the repayment        step 2 returns; step 1 then calls recordRepayment() on line 14.
 *   4. Book it in the ledger       step 3 asks the ledger service, through ledgerClient.book.
 *   5. Email the receipt           step 4 publishes loan.repaid; the mail service handles it.
 */
const STEPS: Step[] = [
  step(1, 'Handle the repay request', 'src/api/repay-route.ts', [5, 40]),
  step(2, 'Check the amount', 'src/loans/validate.ts', [3, 20], {
    step: 1,
    line: 12,
    how: 'call',
  }),
  step(3, 'Record the repayment', 'src/loans/record.ts', [8, 35], {
    step: 1,
    line: 14,
    how: 'call',
  }),
  step(4, 'Book it in the ledger', 'services/ledger/book.ts', [10, 30], {
    step: 3,
    line: 30,
    how: 'service',
    via: 'ledgerClient.book',
  }),
  step(5, 'Email the receipt', 'services/mail/on-repaid.ts', [4, 18], {
    step: 4,
    line: 25,
    how: 'event',
  }),
];

const tour: Tour = {
  repo: 'acme/loans',
  pr: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  source: 'author',
  createdAt: '2026-10-29T12:00:00Z',
  summary: 'Adds early repayment of loans.',
  foundations: [],
  flows: [
    {
      id: 'F1',
      title: 'Repay a loan',
      entry: { kind: 'http', label: 'POST /loans/{id}/repay' },
      steps: STEPS,
    },
  ],
  other: [],
  check: { problems: [] },
  hashes: Object.fromEntries(STEPS.map((s) => [s.id, `h-${s.id}`])),
};

const response: PrResponse = {
  pr: {
    repo: 'acme/loans',
    number: 42,
    title: 'Early repayment',
    author: 'alice',
    url: 'https://github.com/acme/loans/pull/42',
    additions: 1,
    deletions: 0,
    isDraft: false,
    updatedAt: '2026-10-29T12:00:00Z',
    baseSha: tour.baseSha,
    headSha: tour.headSha,
    viewerIsAuthor: false,
  },
  tour,
  seen: {},
  outdated: false,
  job: null,
};

/** The "how did we get here" block of the open step, row by row; [] when it has none. */
const rows = cameFromRows;

async function open(title: string) {
  await screen.findByRole('navigation', { name: 'Tour outline' });
  fireEvent.click(outlineItem(title));
}

beforeEach(() => {
  getPr.mockResolvedValue(response);
  markSeen.mockResolvedValue(undefined);
  render(<TourView repo="acme/loans" pr={42} />);
});

afterEach(() => vi.resetAllMocks());

describe('how the flow gets to a step', () => {
  it('the first step has none: the entry starts the flow', async () => {
    await open('Handle the repay request');
    expect(screen.queryByTestId('came-from')).toBeNull();
  });

  it('a step called by the step just before: no previous-step row', async () => {
    await open('Check the amount');
    expect(rows()).toEqual(['Called from: Step 1 · Handle the repay request line 12 ↗']);
    expect(screen.queryByTestId('came-from-previous')).toBeNull();
  });

  it('a step called after the step before it returned: a jump back up', async () => {
    await open('Record the repayment');
    expect(rows()).toEqual([
      'Called from: Step 1 · Handle the repay request line 14 ↗',
      'Previous step: Step 2 · Check the amount — it returns first, then step 1 calls this step.',
    ]);
    expect(screen.getByTestId('came-from-previous')).toBeTruthy();
  });

  it('a request to another service, through a helper that is not a step', async () => {
    await open('Book it in the ledger');
    expect(rows()).toEqual([
      'Request from: Step 3 · Record the repayment line 30 ↗, through ledgerClient.book',
    ]);
  });

  it('an event that this step handles', async () => {
    await open('Email the receipt');
    expect(rows()).toEqual(['Event from: Step 4 · Book it in the ledger line 25 ↗']);
  });

  it('clicking the line shows the call, then Back returns to the step', async () => {
    await open('Record the repayment');
    expect(screen.getByTestId('code-view').textContent).toBe('src/loans/record.ts:8');

    fireEvent.click(screen.getByRole('button', { name: 'line 14' }));
    expect(screen.getByTestId('code-view').textContent).toBe('src/api/repay-route.ts:14');
    // A look back, not a move: the outline stays on this step.
    expect(outlineItem('Record the repayment').getAttribute('aria-current')).toBe('step');

    fireEvent.click(screen.getByRole('button', { name: 'Back to this step' }));
    expect(screen.getByTestId('code-view').textContent).toBe('src/loans/record.ts:8');
  });
});

/** The note above the step buttons when the next step is not called from this one. */
function nextNote(): string | null {
  return screen.queryByTestId('next-from')?.textContent ?? null;
}

describe('where the next step is called from', () => {
  it('says so when the next step is not called from this one', async () => {
    await open('Check the amount');
    expect(nextNote()).toBe(
      'Next step is called from Handle the repay request (step 1), not from this step.',
    );
  });

  it('says nothing when this step calls the next one', async () => {
    await open('Handle the repay request');
    expect(nextNote()).toBeNull();
    fireEvent.click(outlineItem('Record the repayment'));
    expect(nextNote()).toBeNull();
  });

  it('says nothing on the last step of a flow', async () => {
    await open('Email the receipt');
    expect(nextNote()).toBeNull();
  });
});

function link(from: number, to: number, extra: Partial<FlowLink> = {}): FlowLink {
  return {
    from: `F1.S${from}`,
    to: `F1.S${to}`,
    line: 12,
    how: 'call',
    source: 'both',
    check: 'proven',
    ...extra,
  };
}

/** Shows the example tour again with `links` on its flow, and marks on step 3. */
async function reopen(links: FlowLink[], marks?: Mark[], openTitle = 'Check the amount') {
  cleanup();
  const flow = tour.flows[0]!;
  const steps = STEPS.map((s) => (s.id === 'F1.S3' && marks ? { ...s, marks } : s));
  const checked: Tour = { ...tour, flows: [{ ...flow, steps, links }] };
  getPr.mockResolvedValue({ ...response, tour: checked });
  render(<TourView repo="acme/loans" pr={42} />);
  await open(openTitle);
}

/** The proof tag of the called-from row; null when it has none. */
function tag(): HTMLElement | null {
  return screen.getByTestId('came-from').querySelector('.came-tag');
}

describe('called from, with the code check', () => {
  it('a link only the code found says so in its tag', async () => {
    await reopen([link(1, 2, { source: 'code' })]);
    expect(rows()).toEqual([
      'Called from: Step 1 · Handle the repay request line 12 ↗ ✓ found in the code',
    ]);
    expect(tag()!.className).toContain('came-tag-proven');
  });

  it('a link both agree on is proven in code', async () => {
    await reopen([link(1, 2)]);
    expect(rows()).toEqual([
      'Called from: Step 1 · Handle the repay request line 12 ↗ ✓ proven in code',
    ]);
    expect(tag()!.className).toContain('came-tag-proven');
  });

  it('a link the code does not show is a warning, without a tag', async () => {
    await reopen([link(1, 2, { source: 'claude', check: 'not-found' })]);
    expect(rows()).toEqual([
      'Called from: The tour says Handle the repay request (step 1) calls this, but the code does not show it.',
    ]);
    expect(screen.getByTestId('came-from').querySelector('.came-from-warn')).toBeTruthy();
    expect(tag()).toBeNull();
  });

  it('an unchecked link has no tag; a name-matched one is matched by name', async () => {
    await reopen([link(1, 2, { source: 'claude', check: 'unchecked' })]);
    expect(rows()).toEqual(['Called from: Step 1 · Handle the repay request line 12 ↗']);
    expect(tag()).toBeNull();
    expect(screen.getByTestId('came-from').querySelector('.came-from-warn')).toBeNull();
    await reopen([link(1, 2, { check: 'name-match' })]);
    expect(rows()).toEqual([
      'Called from: Step 1 · Handle the repay request line 12 ↗ matched by name',
    ]);
    expect(tag()!.className).not.toContain('came-tag-proven');
    expect(screen.getByTestId('came-from').querySelector('.came-from-warn')).toBeNull();
  });

  it("puts Claude's reason in the tooltip of an unproven link", async () => {
    await reopen([
      link(1, 2, {
        how: 'service',
        source: 'claude',
        check: 'unchecked',
        reason: 'HTTP call to the ledger service',
      }),
    ]);
    expect(screen.getByTestId('came-from').title).toBe('HTTP call to the ledger service');
    expect(rows()).toEqual(['Request from: Step 1 · Handle the repay request line 12 ↗']);
    expect(tag()).toBeNull();
  });

  it('a name-matched code link is not said to be found in the code', async () => {
    await reopen([link(1, 2, { source: 'code', check: 'name-match' })]);
    expect(rows()).toEqual([
      'Called from: Step 1 · Handle the repay request line 12 ↗ matched by name',
    ]);
  });

  it('a link through a helper names it after the line', async () => {
    await reopen([link(1, 2, { via: ['ledgerClient.book'] })]);
    expect(rows()).toEqual([
      'Called from: Step 1 · Handle the repay request line 12 ↗, through ledgerClient.book ✓ proven in code',
    ]);
  });

  it('several returned steps make a range in the previous-step row', async () => {
    await reopen([link(1, 4, { how: 'service', line: 20 })], undefined, 'Book it in the ledger');
    expect(rows()).toEqual([
      'Request from: Step 1 · Handle the repay request line 20 ↗ ✓ proven in code',
      'Previous step: Steps 2 to 3 return first, then step 1 calls this step.',
    ]);
    expect(screen.getByTestId('came-from-previous').textContent).toContain('Steps 2 to 3');
  });

  it('no next-step note when this step is a secondary caller of the next', async () => {
    // Step 3 is called by step 1 (proven first) and also by step 2.
    await reopen([link(1, 3), link(2, 3, { line: 7 })]);
    expect(nextNote()).toBeNull();
  });

  it('lists the other callers', async () => {
    await reopen([link(1, 3), link(2, 3, { line: 7 })], undefined, 'Record the repayment');
    expect(rows()[0]).toBe(
      'Called from: Step 1 · Handle the repay request line 12 ↗ ✓ proven in code Also called from step 2.',
    );
    const also = screen.getByText('Also called from step 2.');
    expect(also.className).toContain('muted');
  });

  it("prefers the proven link over Claude's, and shows the conflict", async () => {
    await reopen(
      [
        link(1, 3, { source: 'claude', check: 'not-found' }),
        link(2, 3, { source: 'code', line: 7 }),
      ],
      undefined,
      'Record the repayment',
    );
    expect(rows()).toEqual(['Called from: Step 2 · Check the amount line 7 ↗ ✓ found in the code']);
    expect(screen.getByTestId('came-conflict').textContent).toBe(
      'The tour says step 1 calls this. The code says step 2 does.',
    );
  });

  it("the next-step note follows the links, not Claude's from", async () => {
    // Claude says step 3 comes from step 1; the code proves step 2 calls it.
    await reopen([link(2, 3, { source: 'code' })]);
    expect(nextNote()).toBeNull();
  });
});

describe('marks in the step facts', () => {
  const mark = (line: number, source: Mark['source']): Mark => ({
    line,
    kind: 'db-write',
    source,
  });

  async function withEffect(marks: Mark[]) {
    cleanup();
    const steps = STEPS.map((s) =>
      s.id === 'F1.S3'
        ? { ...s, marks, sideEffects: [{ kind: 'db-write' as const, label: 'x' }] }
        : s,
    );
    getPr.mockResolvedValue({
      ...response,
      tour: { ...tour, flows: [{ ...tour.flows[0]!, steps }] },
    });
    render(<TourView repo="acme/loans" pr={42} />);
    await open('Record the repayment');
  }

  it('reveals the first both mark, else the first claude one', async () => {
    await withEffect([mark(9, 'claude'), mark(20, 'both'), mark(22, 'both')]);
    fireEvent.click(screen.getByRole('button', { name: 'writes to DB' }));
    expect(screen.getByTestId('code-view').getAttribute('data-reveal')).toContain('"line":20');
    await withEffect([mark(9, 'claude'), mark(12, 'claude')]);
    fireEvent.click(screen.getByRole('button', { name: 'writes to DB' }));
    expect(screen.getByTestId('code-view').getAttribute('data-reveal')).toContain('"line":9');
  });

  it('stays plain text without a db-write mark', async () => {
    await withEffect([]);
    expect(screen.queryByRole('button', { name: 'writes to DB' })).toBeNull();
    expect(screen.getByText('writes to DB')).toBeTruthy();
  });
});
