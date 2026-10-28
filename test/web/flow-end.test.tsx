import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrResponse } from '../../src/shared/api.js';
import type { Flow, Step, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';

// Where a flow's changes end, and the buttons and keys that move through the tour.

vi.mock('../../src/web/api.js', () => ({
  getPr: vi.fn(),
  buildTour: vi.fn(),
  markSeen: vi.fn(),
}));

// The real code view loads files from the server; these tests are about the tour around it.
vi.mock('../../src/web/CodeView.js', () => ({
  CodeView: ({ homeId }: { homeId: string }) => <div data-testid="code-view">{homeId}</div>,
}));

const getPr = vi.mocked(api.getPr);
const markSeen = vi.mocked(api.markSeen);

function step(id: string, title: string, changed: boolean): Step {
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

function flow(id: string, title: string, steps: Step[]): Flow {
  return { id, title, entry: { kind: 'http', label: `POST /${id}` }, steps };
}

/**
 * Repay: changed, unchanged, changed, then two unchanged steps after the last change.
 * Notify: no changed step at all.
 */
const tour: Tour = {
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

function response(): PrResponse {
  const pr = {
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
  return { pr, tour, seen: {}, outdated: false, job: null };
}

function outline(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Tour outline' });
}

function outlineItem(title: string): HTMLElement {
  return within(outline()).getByRole('button', { name: new RegExp(title) });
}

/** The outline block of one flow: its heading, notes and steps. */
function outlineFlow(title: string): HTMLElement {
  return within(outline()).getByRole('heading', { name: title }).parentElement!;
}

function currentTitle(): string {
  return within(outline()).getByRole('button', { current: 'step' }).textContent ?? '';
}

function isBefore(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

async function open(title?: string) {
  getPr.mockResolvedValue(response());
  render(<TourView repo="acme/loans" pr={42} />);
  await screen.findByRole('navigation', { name: 'Tour outline' });
  if (title !== undefined) fireEvent.click(outlineItem(title));
  markSeen.mockClear();
}

beforeEach(() => {
  markSeen.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('outline: where a flow stops changing', () => {
  it('a divider follows the last changed step, not the unchanged steps between changes', async () => {
    await open();
    const repay = outlineFlow('Repay a loan');

    const dividers = within(repay).getAllByRole('separator');
    expect(dividers.map((d) => d.textContent)).toEqual(['No more changes in this flow']);
    const divider = dividers[0]!;
    expect(isBefore(outlineItem('Record the repayment'), divider)).toBe(true);
    expect(isBefore(divider, outlineItem('Send the receipt'))).toBe(true);
  });

  it('steps after the last change are dimmed but still unchanged and clickable', async () => {
    await open();

    const after = outlineItem('Send the receipt');
    expect(after.closest('li')!.className).toContain('after-changes');
    expect(within(after).getByText('unchanged')).toBeTruthy();
    expect(outlineItem('Load the loan').closest('li')!.className).not.toContain('after-changes');

    fireEvent.click(after);
    expect(after.getAttribute('aria-current')).toBe('step');
  });

  it('a flow without changed steps says so at its top, with no divider', async () => {
    await open();
    const notify = outlineFlow('Notify the lender');

    const note = within(notify).getByText('No changes in this flow');
    expect(isBefore(note, outlineItem('Pick the lender'))).toBe(true);
    expect(within(notify).queryByRole('separator')).toBeNull();
    expect(outlineItem('Pick the lender').closest('li')!.className).toContain('after-changes');
  });
});

describe('step panel: the first step after the last change', () => {
  const NOTE = 'No more changes in this flow. The steps below show how it continues.';

  it('shows the note only on the first step after the last change', async () => {
    await open('Send the receipt');
    expect(screen.getByText(NOTE)).toBeTruthy();

    fireEvent.click(outlineItem('Load the loan'));
    expect(screen.queryByText(NOTE)).toBeNull();
    fireEvent.click(outlineItem('Return the response'));
    expect(screen.queryByText(NOTE)).toBeNull();
    fireEvent.click(outlineItem('Record the repayment'));
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('Skip to next flow goes to the next flow and marks the step seen', async () => {
    await open('Send the receipt');

    const skip = screen.getByRole('button', { name: 'Skip to next flow' });
    expect(skip.title).toBe('Skip to next flow (])');
    fireEvent.click(skip);

    expect(currentTitle()).toContain('Pick the lender');
    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'F1.S4', 'h-14');
  });

  it('a flow without changes has its own note on its first step', async () => {
    await open('Pick the lender');
    expect(screen.getByText(/No changes in this flow\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip to next flow' })).toBeTruthy();
  });
});

describe('step panel: previous and next step buttons', () => {
  it('Next step marks the current home seen and moves on, like j', async () => {
    await open();

    const next = screen.getByRole('button', { name: 'Next step' });
    expect(next.title).toBe('Next step (j)');
    fireEvent.click(next);

    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'f1', 'h-f1');
    expect(currentTitle()).toContain('Parse the request');
  });

  it('Next step on the last item marks it seen and stays there', async () => {
    await open('Repay tests');

    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));

    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'o1.1', 'h-o1');
    expect(currentTitle()).toContain('Repay tests');
  });

  it('Previous step moves back, like k, and is off on the first item', async () => {
    await open();
    const previous = screen.getByRole('button', { name: 'Previous step' });
    expect(previous.title).toBe('Previous step (k)');
    expect((previous as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(outlineItem('Load the loan'));
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(currentTitle()).toContain('Parse the request');
  });
});

describe('flow navigation: [ and ]', () => {
  it('] goes to the first step of the next flow and marks the current home seen', async () => {
    await open('Load the loan');

    fireEvent.keyDown(window, { key: ']' });

    expect(currentTitle()).toContain('Pick the lender');
    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'F1.S2', 'h-12');
  });

  it('] goes from a foundation to the first flow, and from the last flow to other changes', async () => {
    await open();

    fireEvent.keyDown(window, { key: ']' });
    expect(currentTitle()).toContain('Parse the request');
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: ']' });
    expect(currentTitle()).toContain('Repay tests');

    markSeen.mockClear();
    fireEvent.keyDown(window, { key: ']' });
    expect(currentTitle()).toContain('Repay tests');
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('[ goes to the first step of the previous flow, and from the first flow to the foundation', async () => {
    await open('Queue the email');

    fireEvent.keyDown(window, { key: '[' });
    expect(currentTitle()).toContain('Parse the request');
    expect(markSeen).toHaveBeenCalledWith('acme/loans', 42, 'F2.S2', 'h-22');

    fireEvent.keyDown(window, { key: '[' });
    expect(currentTitle()).toContain('Create repayments table');

    fireEvent.keyDown(window, { key: '[' });
    expect(currentTitle()).toContain('Create repayments table');
  });

  it('[ and ] typed into a text field do not navigate', async () => {
    getPr.mockResolvedValue(response());
    render(
      <>
        <input aria-label="note" />
        <TourView repo="acme/loans" pr={42} />
      </>,
    );
    await screen.findByRole('navigation', { name: 'Tour outline' });

    fireEvent.keyDown(screen.getByLabelText('note'), { key: ']' });
    expect(currentTitle()).toContain('Create repayments table');

    fireEvent.click(outlineItem('Queue the email'));
    fireEvent.keyDown(screen.getByLabelText('note'), { key: '[' });
    expect(currentTitle()).toContain('Queue the email');
  });

  it('a step shows Previous flow and Next flow buttons with their keys', async () => {
    await open('Load the loan');

    const previous = screen.getByRole('button', { name: 'Previous flow' });
    const next = screen.getByRole('button', { name: 'Next flow' });
    expect(previous.title).toBe('Previous flow ([)');
    expect(next.title).toBe('Next flow (])');

    fireEvent.click(next);
    expect(currentTitle()).toContain('Pick the lender');
    fireEvent.click(screen.getByRole('button', { name: 'Previous flow' }));
    expect(currentTitle()).toContain('Parse the request');
  });

  it('a foundation has flow buttons too: Next flow works, Previous flow is off', async () => {
    await open();
    const previous = screen.getByRole<HTMLButtonElement>('button', { name: 'Previous flow' });
    expect(previous.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Next flow' }));
    expect(currentTitle()).toContain('Parse the request');
  });

  it('an other-changes item has flow buttons too: Previous flow works, Next flow is off', async () => {
    await open('Repay tests');
    const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Next flow' });
    expect(next.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Previous flow' }));
    expect(currentTitle()).toContain('Pick the lender');
  });
});
