import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '../../src/shared/diff.js';
import type { PlacedProblem } from '../../src/shared/problems.js';
import type { ReviewThread } from '../../src/shared/review.js';
import type { Flow, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { CodeView } from '../../src/web/CodeView.js';
import { homesInOrder } from '../../src/web/homes.js';
import { Peek } from '../../src/web/Peek.js';
import { StepPane } from '../../src/web/StepPane.js';
import type { ReviewState } from '../../src/web/useReview.js';
import { line, problem, WithProblems } from './problems-fake.js';
import { fakeReview } from './review-fake.js';

// Possible problems in the tour: under their line in the code, and at the top of their step.

vi.mock('../../src/web/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getFile: vi.fn(),
  getDiff: vi.fn(),
}));

vi.mock('../../src/web/highlight.js', () => ({
  highlight: (text: string) => Promise.resolve(text.split('\n').map((line) => [{ content: line }])),
}));

const getFile = vi.mocked(api.getFile);
const getDiff = vi.mocked(api.getDiff);

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const PATH = 'src/repay.ts';

function lines(n: number, change: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
}

/** One change: line 5 replaced. The file has 50 lines, so line 42 is folded away. */
function serve() {
  const diff = (path: string): FileDiff => ({
    path,
    oldPath: path,
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: 4,
        oldLines: 3,
        newStart: 4,
        newLines: 3,
        lines: [
          { kind: 'ctx', oldNo: 4, newNo: 4, text: 'line 4' },
          { kind: 'del', oldNo: 5, text: 'old five' },
          { kind: 'add', newNo: 5, text: 'new five' },
          { kind: 'ctx', oldNo: 6, newNo: 6, text: 'line 6' },
        ],
      },
    ],
  });
  getDiff.mockImplementation((_repo, _pr, path) => Promise.resolve(diff(path)));
  getFile.mockImplementation((_repo, _pr, sha) =>
    Promise.resolve({ text: lines(50, { 5: sha === HEAD ? 'new five' : 'old five' }) }),
  );
}

function makeFlow(): Flow {
  return {
    id: 'F1',
    title: 'Repay a loan',
    entry: { kind: 'http', label: 'POST /loans/{id}/repay' },
    steps: [
      {
        id: 'F1.S1',
        title: 'Charge the fee',
        file: PATH,
        startLine: 4,
        endLine: 6,
        changed: true,
        why: 'Because.',
        risk: 'skim',
        sideEffects: [],
        tests: [{ file: 'test/repay.test.ts', name: 'TestRepayChargesFee' }],
        calls: [],
        homes: [{ file: PATH, side: 'new', start: 5, end: 5 }],
      },
    ],
    links: [],
  };
}

function makeTour(): Tour {
  return {
    repo: 'acme/loans',
    pr: 42,
    baseSha: BASE,
    headSha: HEAD,
    source: 'author',
    createdAt: '2026-11-07T12:00:00Z',
    summary: 'Adds early repayment of loans.',
    foundations: [],
    flows: [makeFlow()],
    other: [],
    check: { problems: [] },
    hashes: {},
  };
}

const FEE = problem('fee', 'risk', line(PATH, 42), 'F1.S1', {
  title: 'The fee is charged after the repayment is stored.',
  why: 'If the charge fails, the repayment stays without a fee.',
  sources: ['CodeRabbit', 'golangci-lint'],
});

function renderCode(
  problems: PlacedProblem[],
  options: { review?: ReviewState; readOnly?: boolean } = {},
) {
  render(
    <WithProblems value={{ problems }}>
      <CodeView
        repo="acme/loans"
        pr={42}
        tour={makeTour()}
        file={PATH}
        focus={{ start: 5, end: 5 }}
        homeId="F1.S1"
        review={options.review ?? fakeReview()}
        onJump={vi.fn()}
        onOpenHome={vi.fn()}
        readOnly={options.readOnly ?? false}
      />
    </WithProblems>,
  );
}

/** The card of the problem titled `title`. */
async function findCard(title: string): Promise<HTMLElement> {
  const text = await screen.findByText(title);
  return text.closest<HTMLElement>('.problem-card')!;
}

/** The code row a card is shown under. */
function rowAbove(el: Element): Element {
  const items = el.closest('.code-review-row');
  if (!items) throw new Error('not shown under a row');
  return items.previousElementSibling!;
}

beforeEach(() => {
  vi.resetAllMocks();
  serve();
});

describe('Possible problems in the code', () => {
  it('shows a problem right under its line', async () => {
    renderCode([FEE]);
    const card = await findCard(FEE.title);
    expect(rowAbove(card).querySelector('.code-text')!.textContent).toBe('line 42');
    expect(within(card).getByText('Risk')).toBeTruthy();
    expect(within(card).getByText(FEE.why!)).toBeTruthy();
    expect(within(card).getByText('CodeRabbit')).toBeTruthy();
    expect(within(card).getByText('golangci-lint')).toBeTruthy();
    expect(card.classList.contains('problem-risk')).toBe(true);
  });

  it('keeps the row of a problem unfolded', async () => {
    renderCode([FEE]);
    await findCard(FEE.title);
    expect(screen.getByText('line 42')).toBeTruthy();
    // The rows around it stay folded.
    expect(screen.queryByText('line 30')).toBeNull();
  });

  it('Comment opens the composer on that line with the problem text', async () => {
    const review = fakeReview();
    renderCode([{ ...FEE, at: line(PATH, 5) }], { review });
    const card = await findCard(FEE.title);

    fireEvent.click(within(card).getByRole('button', { name: 'Comment' }));
    const field = screen.getByRole('textbox', { name: `Comment on ${PATH}` });
    expect((field as HTMLTextAreaElement).value).toBe(`${FEE.title}\n\n${FEE.why}`);
    expect(rowAbove(field).querySelector('.code-text')!.textContent).toBe('new five');

    // It is a normal draft: edited, then added on that line.
    fireEvent.change(field, { target: { value: 'Charge first?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    await vi.waitFor(() =>
      expect(review.add).toHaveBeenCalledWith({
        kind: 'comment',
        path: PATH,
        side: 'new',
        startLine: 5,
        endLine: 5,
        headSha: HEAD,
        body: 'Charge first?',
      }),
    );
  });

  it('Cancel closes an untouched problem comment at once', async () => {
    renderCode([{ ...FEE, at: line(PATH, 5) }]);
    const card = await findCard(FEE.title);
    fireEvent.click(within(card).getByRole('button', { name: 'Comment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('Comment on a second problem of the same line fills in its text', async () => {
    const other = problem('other', 'look', line(PATH, 5), 'F1.S1', { title: 'Name it fee.' });
    renderCode([{ ...FEE, at: line(PATH, 5) }, other]);
    const first = await findCard(FEE.title);
    fireEvent.click(within(first).getByRole('button', { name: 'Comment' }));
    fireEvent.click(
      within(await findCard('Name it fee.')).getByRole('button', { name: 'Comment' }),
    );
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Name it fee.');
  });

  it('Not a problem collapses the card to one line', async () => {
    renderCode([FEE]);
    const card = await findCard(FEE.title);
    const real = within(card).getByRole('button', { name: 'Real problem' });
    const not = within(card).getByRole('button', { name: 'Not a problem' });
    expect(real.getAttribute('aria-pressed')).toBe('false');
    expect(not.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(not);
    const folded = screen.getByRole('button', { name: `Not a problem · ${FEE.title}` });
    expect(screen.queryByText(FEE.why!)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Real problem' })).toBeNull();

    // A click opens it again, with its mark showing.
    fireEvent.click(folded);
    expect(screen.getByText(FEE.why!)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not a problem' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('a bot thread shows its level and the mark buttons, and no second card', async () => {
    const botThread: ReviewThread = {
      id: 'T1',
      path: PATH,
      side: 'new',
      line: 42,
      startLine: null,
      outdated: false,
      resolved: false,
      bot: true,
      comments: [
        {
          id: 'c1',
          author: 'coderabbitai[bot]',
          body: 'The fee is charged after the repayment is stored.',
          createdAt: '2026-11-07T09:00:00Z',
          url: 'https://github.com/acme/loans/pull/42#discussion_c1',
        },
      ],
    };
    renderCode([{ ...FEE, threadId: 'T1' }], { review: fakeReview({ threads: [botThread] }) });

    const thread = await screen.findByRole('region', { name: `Thread on ${PATH}` });
    expect(rowAbove(thread).querySelector('.code-text')!.textContent).toBe('line 42');
    expect(within(thread).getByText('Risk')).toBeTruthy();
    expect(within(thread).getByRole('button', { name: 'Real problem' })).toBeTruthy();
    expect(document.querySelector('.problem-card')).toBeNull();
  });

  it('the peek shows problems without buttons', async () => {
    const tour = makeTour();
    render(
      <WithProblems value={{ problems: [{ ...FEE, at: line(PATH, 5) }] }}>
        <Peek
          repo="acme/loans"
          pr={42}
          tour={tour}
          flow={tour.flows[0]!}
          stepId="F1.S1"
          line={null}
          seen={false}
          keys
          review={fakeReview()}
          onMove={vi.fn()}
          onMarkSeen={vi.fn()}
          onOpenInTour={vi.fn()}
          onClose={vi.fn()}
        />
      </WithProblems>,
    );
    const card = await findCard(FEE.title);
    expect(within(card).getByText('Risk')).toBeTruthy();
    expect(within(card).queryByRole('button')).toBeNull();
  });
});

describe('Possible problems at the top of the step', () => {
  function renderStep(problems: PlacedProblem[]) {
    const tour = makeTour();
    const home = homesInOrder(tour).find((h) => h.id === 'F1.S1')!;
    render(
      <WithProblems value={{ problems }}>
        <StepPane
          repo="acme/loans"
          pr={42}
          tour={tour}
          home={home}
          jump={null}
          reveal={null}
          onJump={vi.fn()}
          onShowLine={vi.fn()}
          onRevealLine={vi.fn()}
          onBack={vi.fn()}
          onOpenHome={vi.fn()}
          onOpenMap={vi.fn()}
          nav={{
            previousStep: undefined,
            nextStep: vi.fn(),
            previousFlow: undefined,
            nextFlow: undefined,
          }}
          review={fakeReview()}
        />
      </WithProblems>,
    );
  }

  it('a failing test shows at the top of its step', () => {
    const failing = problem('ci', 'bug', { kind: 'step', test: 'TestRepayChargesFee' }, 'F1.S1', {
      title: 'Test TestRepayChargesFee fails in CI',
      sources: ['CI'],
      url: 'https://github.com/acme/loans/actions/runs/1',
    });
    // A step problem of another home, and a line problem of this one, are not in the band.
    const elsewhere = problem('x', 'bug', { kind: 'step', test: 'TestOther' }, 'F2.S1');
    renderStep([failing, elsewhere, { ...FEE, at: line(PATH, 5) }]);

    const band = screen.getByRole('region', { name: 'Possible problems in this step' });
    // Under the title.
    const title = screen.getByRole('heading', { name: 'Charge the fee' });
    expect(title.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const card = within(band).getByText(failing.title).closest<HTMLElement>('.problem-card')!;
    expect(within(card).getByText('Likely bug')).toBeTruthy();
    expect(within(card).getByRole('link', { name: failing.title }).getAttribute('href')).toBe(
      failing.url,
    );
    expect(within(band).queryByText('Title x')).toBeNull();
    expect(within(band).queryByText(FEE.title)).toBeNull();
    // The marks work here too; there is no line to comment on.
    expect(within(card).getByRole('button', { name: 'Real problem' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Comment' })).toBeNull();
  });

  it('no band when the step has no step or file problems', () => {
    renderStep([{ ...FEE, at: line(PATH, 5) }]);
    expect(screen.queryByRole('region', { name: 'Possible problems in this step' })).toBeNull();
  });
});
