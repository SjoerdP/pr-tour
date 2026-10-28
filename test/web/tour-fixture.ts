import type { PrResponse, PrSummary } from '../../src/shared/api.js';
import type { Flow, Step, Tour } from '../../src/shared/tour.js';

// A small tour with a foundation, two flows and one other-changes group, shared by the
// tests that walk through the outline and the step panel.

export function step(id: string, title: string, changed: boolean): Step {
  return {
    id,
    title,
    file: 'src/a.ts',
    startLine: 1,
    endLine: 9,
    changed,
    why: `Why ${title}.`,
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes: changed ? [{ file: 'src/a.ts', side: 'new', start: 1, end: 9 }] : [],
  };
}

export function flow(id: string, title: string, steps: Step[]): Flow {
  return { id, title, entry: { kind: 'http', label: `POST /${id}` }, steps };
}

/**
 * Repay: changed, unchanged, changed, then two unchanged steps after the last change.
 * Notify: no changed step at all.
 */
export const tour: Tour = {
  repo: 'acme/loans',
  pr: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  source: 'author',
  createdAt: '2026-10-27T12:00:00Z',
  summary: 'Adds early repayment.',
  foundations: [
    {
      id: 'f1',
      kind: 'migration',
      title: 'Create repayments table',
      file: 'm.sql',
      why: 'Stores repayments.',
      risk: 'skim',
      homes: [{ file: 'm.sql', side: 'new', start: 1, end: 3 }],
    },
  ],
  flows: [
    flow('F1', 'Repay a loan', [
      step('F1.S1', 'Parse the request', true),
      step('F1.S2', 'Load the loan', false),
      step('F1.S3', 'Record the repayment', true),
      step('F1.S4', 'Send the receipt', false),
      step('F1.S5', 'Return the response', false),
    ]),
    flow('F2', 'Notify the lender', [
      step('F2.S1', 'Pick the lender', false),
      step('F2.S2', 'Queue the email', false),
    ]),
  ],
  other: [
    {
      kind: 'tests',
      title: 'Tests',
      summary: 'Tests for repay.',
      items: [
        {
          id: 'o1.1',
          file: 'test/repay.test.ts',
          title: 'Repay tests',
          homes: [{ file: 'test/repay.test.ts', side: 'new', start: 1, end: 9 }],
        },
      ],
    },
  ],
  check: { problems: [] },
  hashes: {
    f1: 'h-f1',
    'F1.S1': 'h-11',
    'F1.S2': 'h-12',
    'F1.S3': 'h-13',
    'F1.S4': 'h-14',
    'F1.S5': 'h-15',
    'F2.S1': 'h-21',
    'F2.S2': 'h-22',
    'o1.1': 'h-o1',
  },
};

export const summary: PrSummary = {
  repo: 'acme/loans',
  number: 42,
  title: 'Early repayment',
  author: 'alice',
  url: 'https://github.com/acme/loans/pull/42',
  additions: 1,
  deletions: 0,
  isDraft: false,
  updatedAt: '2026-10-27T12:00:00Z',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
};

export function response(overrides: Partial<PrResponse> = {}): PrResponse {
  return { pr: summary, tour, seen: {}, outdated: false, job: null, ...overrides };
}
