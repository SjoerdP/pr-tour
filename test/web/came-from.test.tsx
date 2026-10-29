import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrResponse } from '../../src/shared/api.js';
import type { Step, StepFrom, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';
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
  CodeView: ({ file, focus }: { file: string; focus: { start: number } | null }) => (
    <div data-testid="code-view">{`${file}:${focus?.start}`}</div>
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

/** The "how did we get here" line of the open step; null when it has none. */
function cameFrom(): string | null {
  return screen.queryByTestId('came-from')?.textContent ?? null;
}

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
    expect(cameFrom()).toBeNull();
  });

  it('a step called by the step just before', async () => {
    await open('Check the amount');
    expect(cameFrom()).toBe('Called from Handle the repay request (step 1), line 12.');
  });

  it('a step called after the step before it returned: a jump back up', async () => {
    await open('Record the repayment');
    expect(cameFrom()).toBe(
      'Called from Handle the repay request (step 1), line 14. Step 2 returned first.',
    );
  });

  it('a request to another service, through a helper that is not a step', async () => {
    await open('Book it in the ledger');
    expect(cameFrom()).toBe(
      'Request from Record the repayment (step 3), line 30, through ledgerClient.book.',
    );
  });

  it('an event that this step handles', async () => {
    await open('Email the receipt');
    expect(cameFrom()).toBe('Event from Book it in the ledger (step 4), line 25.');
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
