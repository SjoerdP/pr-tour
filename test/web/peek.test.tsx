import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '../../src/shared/diff.js';
import type { Flow, Step, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { Peek } from '../../src/web/Peek.js';
import { fakeReview } from './review-fake.js';

vi.mock('../../src/web/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getFile: vi.fn(),
  getDiff: vi.fn(),
}));

// Shiki is not what these tests are about: one plain token per line.
vi.mock('../../src/web/highlight.js', () => ({
  highlight: (text: string) => Promise.resolve(text.split('\n').map((line) => [{ content: line }])),
}));

const getFile = vi.mocked(api.getFile);
const getDiff = vi.mocked(api.getDiff);

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function lines(n: number, change: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
}

/** Every file has 10 lines; line 5 changed, line 6 calls the fee step. */
function serve() {
  const diff = (path: string): FileDiff => ({
    path,
    oldPath: path,
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: 5,
        oldLines: 1,
        newStart: 5,
        newLines: 1,
        lines: [
          { kind: 'del', oldNo: 5, text: 'old five' },
          { kind: 'add', newNo: 5, text: 'new five' },
        ],
      },
    ],
  });
  getDiff.mockImplementation((_repo, _pr, path) => Promise.resolve(diff(path)));
  getFile.mockImplementation((_repo, _pr, sha) =>
    Promise.resolve({
      text:
        sha === HEAD
          ? lines(10, { 5: 'new five', 6: '  chargeFee(loan);', 7: '  notify(loan);' })
          : lines(10, { 5: 'old five' }),
    }),
  );
}

function step(id: string, title: string, file: string, extra: Partial<Step> = {}): Step {
  return {
    id,
    title,
    file,
    startLine: 5,
    endLine: 8,
    changed: true,
    why: 'Because.',
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes: [{ file, side: 'new', start: 5, end: 5 }],
    ...extra,
  };
}

function makeFlow(): Flow {
  return {
    id: 'F1',
    title: 'Repay a loan',
    entry: { kind: 'http', label: 'POST /loans/{id}/repay' },
    steps: [
      step('F1.S1', 'Handle the repay request', 'src/repay.ts', {
        callSites: [
          { line: 6, col: 3, endCol: 12, to: { file: 'src/fees.ts', line: 5 }, toStep: 'F1.S2' },
          { line: 7, col: 3, endCol: 9, to: { file: 'src/notify.ts', line: 1 } },
        ],
      }),
      step('F1.S2', 'Charge the fee', 'src/fees.ts', {
        risk: 'read-closely',
        riskReason: 'Money moves here.',
        sideEffects: [
          { kind: 'db-write', label: 'fees table' },
          { kind: 'event', label: 'FeeCharged' },
        ],
        homes: [
          { file: 'src/fees.ts', side: 'new', start: 5, end: 5 },
          { file: 'src/fees.ts', side: 'new', start: 7, end: 7 },
        ],
      }),
      step('F1.S3', 'Send the receipt', 'src/mail.ts', { homes: [], changed: false }),
    ],
    links: [{ from: 'F1.S1', to: 'F1.S2', line: 6, how: 'call', source: 'both', check: 'proven' }],
  };
}

function makeTour(flow: Flow): Tour {
  return {
    repo: 'acme/loans',
    pr: 42,
    baseSha: BASE,
    headSha: HEAD,
    source: 'author',
    createdAt: '2026-11-05T12:00:00Z',
    summary: 'Adds early repayment of loans.',
    foundations: [],
    flows: [flow],
    other: [],
    check: { problems: [] },
    hashes: {},
  };
}

type Props = Parameters<typeof Peek>[0];

function renderPeek(props: Partial<Props> = {}) {
  const flow = makeFlow();
  const handlers = {
    onMove: vi.fn(),
    onMarkSeen: vi.fn(),
    onOpenInTour: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <Peek
      repo="acme/loans"
      pr={42}
      tour={makeTour(flow)}
      flow={flow}
      stepId="F1.S2"
      line={null}
      seen={false}
      keys
      review={fakeReview()}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

beforeEach(() => {
  vi.resetAllMocks();
  serve();
});

describe('Peek', () => {
  it('shows the trail, the title, the tags and the read-closely reason', async () => {
    renderPeek();
    await screen.findByText('new five');

    const trail = screen.getByTestId('peek-trail').textContent;
    expect(trail).toContain('Flow 1 · step 2 of 3');
    expect(trail).toContain('called from step 1, line 6');
    expect(trail).toContain('✓ proven in code');
    expect(screen.getByRole('heading', { name: 'Charge the fee' })).toBeTruthy();
    const tags = screen.getByRole('list', { name: 'Step tags' });
    expect([...tags.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'read closely',
      '2 changes',
      'db',
      'event',
      'not seen yet',
    ]);
    expect(screen.getByText('Money moves here.')).toBeTruthy();
  });

  it('says "no changes" and "seen", and has no "Mark as seen" for a seen step', async () => {
    renderPeek({ stepId: 'F1.S3', seen: true });
    await screen.findByText('new five');

    const tags = screen.getByRole('list', { name: 'Step tags' });
    expect([...tags.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'no changes',
      'seen',
    ]);
    expect(screen.queryByRole('button', { name: 'Mark as seen' })).toBeNull();
  });

  it('leaves out the caller for the first step', async () => {
    renderPeek({ stepId: 'F1.S1' });
    await screen.findByText('new five');
    expect(screen.getByTestId('peek-trail').textContent).toBe('Flow 1 · step 1 of 3');
  });

  it('the buttons call their handlers', async () => {
    const { onMarkSeen, onOpenInTour, onClose } = renderPeek();
    await screen.findByText('new five');

    fireEvent.click(screen.getByRole('button', { name: /Open in tour/ }));
    expect(onOpenInTour).toHaveBeenCalledWith('F1.S2');
    fireEvent.click(screen.getByRole('button', { name: 'Mark as seen' }));
    expect(onMarkSeen).toHaveBeenCalledWith('F1.S2');
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.title).toContain('Esc');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a "→ step N" badge moves the peek to that step', async () => {
    const { onMove } = renderPeek({ stepId: 'F1.S1' });
    await screen.findByText('new five');

    fireEvent.click(screen.getByRole('button', { name: /→ step 2/ }));
    expect(onMove).toHaveBeenCalledWith('F1.S2', null);
  });

  it('a call into a step of the flow moves the peek; other calls do nothing', async () => {
    const { onMove } = renderPeek({ stepId: 'F1.S1' });
    await screen.findByText('new five');

    fireEvent.click(screen.getByRole('button', { name: 'notify' }));
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'chargeFee' }));
    expect(onMove).toHaveBeenCalledWith('F1.S2', null);
  });

  it("a caller the code check did not find reads as the tour's claim, without a line", async () => {
    const flow = makeFlow();
    flow.links = [
      { from: 'F1.S1', to: 'F1.S2', line: 6, how: 'call', source: 'claude', check: 'not-found' },
    ];
    renderPeek({ flow, tour: makeTour(flow) });
    await screen.findByText('new five');

    const trail = screen.getByTestId('peek-trail');
    expect(trail.textContent).toBe(
      'Flow 1 · step 2 of 3 · the tour says step 1 calls this; the code does not show it',
    );
    expect(trail.querySelector('.came-from-warn')).toBeTruthy();
  });

  it('shows the code read-only: no comment buttons', async () => {
    renderPeek();
    await screen.findByText('new five');
    expect(screen.queryByRole('button', { name: /^Comment on/ })).toBeNull();
  });
});
