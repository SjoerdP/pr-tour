import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrResponse } from '../../src/shared/api.js';
import type { Step, Tour } from '../../src/shared/tour.js';
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

vi.mock('../../src/web/CodeView.js', () => ({ CodeView: () => <div /> }));

const getPr = vi.mocked(api.getPr);

function step(n: number, title: string, file: string, calls: Step['calls'] = []): Step {
  return {
    id: `F1.S${n}`,
    title,
    file,
    startLine: 1,
    endLine: 30,
    changed: false,
    why: `${title}.`,
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls,
    homes: [],
  };
}

// A tour from before steps had "from": only the calls each step lists. Step 1 calls both
// step 2 and step 3; step 2 calls nothing.
const STEPS = [
  step(1, 'Handle the repay request', 'src/api/repay-route.ts', [
    { symbol: 'validateRepayment', file: 'src/loans/validate.ts', line: 3 },
    { symbol: 'recordRepayment', file: 'src/loans/record.ts', line: 8 },
  ]),
  step(2, 'Check the amount', 'src/loans/validate.ts'),
  step(3, 'Record the repayment', 'src/loans/record.ts'),
];

const tour: Tour = {
  repo: 'acme/loans',
  pr: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  source: 'inferred',
  createdAt: '2026-10-28T12:00:00Z',
  summary: 'Adds early repayment of loans.',
  foundations: [],
  flows: [
    { id: 'F1', title: 'Repay', entry: { kind: 'http', label: 'POST /repay' }, steps: STEPS },
  ],
  other: [],
  check: { problems: [] },
  hashes: {},
};

afterEach(() => vi.resetAllMocks());

describe('a tour without "from": worked out from the calls', () => {
  it('shows the caller without a line, and where the next step is called from', async () => {
    getPr.mockResolvedValue({
      pr: {
        repo: 'acme/loans',
        number: 42,
        title: 'Early repayment',
        author: 'alice',
        url: 'https://github.com/acme/loans/pull/42',
        additions: 1,
        deletions: 0,
        isDraft: false,
        updatedAt: '2026-10-28T12:00:00Z',
        baseSha: tour.baseSha,
        headSha: tour.headSha,
        viewerIsAuthor: false,
      },
      tour,
      seen: {},
      outdated: false,
      job: null,
    } satisfies PrResponse);
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });

    fireEvent.click(outlineItem('Check the amount'));
    expect(screen.getByTestId('came-from').textContent).toBe(
      'Called from Handle the repay request (step 1).',
    );
    expect(screen.getByTestId('next-from').textContent).toBe(
      'Next step is called from Handle the repay request (step 1), not from this step.',
    );

    fireEvent.click(outlineItem('Record the repayment'));
    expect(screen.getByTestId('came-from').textContent).toBe(
      'Called from Handle the repay request (step 1). Step 2 returned first.',
    );
  });
});
