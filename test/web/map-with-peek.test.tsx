import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Flow, Step, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { MapWithPeek, type PeekState } from '../../src/web/MapWithPeek.js';
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

const KEY = 'pr-tour.peek-split';

function step(id: string, title: string, file: string): Step {
  return {
    id,
    title,
    file,
    startLine: 1,
    endLine: 8,
    changed: true,
    why: 'Because.',
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes: [{ file, side: 'new', start: 5, end: 5 }],
  };
}

function makeFlow(id = 'F1'): Flow {
  return {
    id,
    title: 'Repay a loan',
    entry: { kind: 'http', label: 'POST /loans/{id}/repay' },
    steps: [
      {
        ...step(`${id}.S1`, 'Handle the repay request', 'src/repay.ts'),
        // "six" on line 6 calls the fee step.
        callSites: [
          { line: 6, col: 1, endCol: 4, to: { file: 'src/fees.ts', line: 1 }, toStep: `${id}.S2` },
        ],
      },
      step(`${id}.S2`, 'Charge the fee', 'src/fees.ts'),
    ],
    links: [
      { from: `${id}.S1`, to: `${id}.S2`, line: 6, how: 'call', source: 'both', check: 'proven' },
    ],
  };
}

function makeTour(flows: Flow[]): Tour {
  return {
    repo: 'acme/loans',
    pr: 42,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    source: 'author',
    createdAt: '2026-11-05T12:00:00Z',
    summary: 'Adds early repayment of loans.',
    foundations: [],
    flows,
    other: [],
    check: { problems: [] },
    hashes: {},
  };
}

type Props = Parameters<typeof MapWithPeek>[0];

function show(props: Partial<Props> = {}) {
  const flow = makeFlow();
  const onPeek = vi.fn();
  const view = render(
    <MapWithPeek
      place="panel"
      flow={flow}
      currentId="F1.S1"
      peek={null}
      peekProps={{
        repo: 'acme/loans',
        pr: 42,
        tour: makeTour([flow, makeFlow('F2')]),
        keys: true,
        review: fakeReview(),
        isSeen: () => false,
        onMarkSeen: vi.fn(),
        onOpenInTour: vi.fn(),
      }}
      onPeek={onPeek}
      {...props}
    />,
  );
  return { onPeek, view };
}

const peekAt = (stepId: string, line: number | null = null): PeekState => ({
  flowId: 'F1',
  stepId,
  line,
});

function box(no: number): HTMLElement {
  const box = screen.getByText(`Step ${no}`).closest('button');
  if (!box) throw new Error(`no box for step ${no}`);
  return box;
}

beforeEach(() => {
  vi.resetAllMocks();
  getDiff.mockImplementation((_repo, _pr, path) =>
    Promise.resolve({ path, oldPath: path, status: 'modified', binary: false, hunks: [] }),
  );
  getFile.mockResolvedValue({ text: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MapWithPeek', () => {
  it('a box click peeks at that step', () => {
    const { onPeek } = show();
    fireEvent.click(box(2));
    expect(onPeek).toHaveBeenCalledWith({ flowId: 'F1', stepId: 'F1.S2', line: null });
  });

  it('an arrow click peeks at the caller, on the calling line', () => {
    const { onPeek } = show();
    fireEvent.click(screen.getByRole('button', { name: /^line 6/ }));
    expect(onPeek).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'F1', stepId: 'F1.S1', line: 6 }),
    );
  });

  it('the same arrow twice gives two different peeks, so the line flashes again', () => {
    const { onPeek } = show();
    const arrow = screen.getByRole('button', { name: /^line 6/ });
    fireEvent.click(arrow);
    fireEvent.click(arrow);
    const [first, second] = onPeek.mock.calls.map(([p]) => p as PeekState);
    expect(first!.nonce).not.toBe(second!.nonce);
  });

  it('without a peek there is no divider', () => {
    show();
    expect(screen.getByRole('list', { name: 'Calls in this flow' })).toBeTruthy();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('with a peek the map, the divider and the peek all show', async () => {
    show({ peek: peekAt('F1.S2') });
    expect(screen.getByRole('list', { name: 'Calls in this flow' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Charge the fee' })).toBeTruthy();
    const divider = screen.getByRole('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('horizontal');
    expect(divider.getAttribute('aria-valuenow')).toBe('40');
    expect(divider.getAttribute('aria-valuemin')).toBe('15');
    expect(divider.getAttribute('aria-valuemax')).toBe('85');
    expect(box(2).className).toContain('peeked');
    await screen.findByText('five');
  });

  it('does not show a peek of another flow', () => {
    show({ peek: { flowId: 'F2', stepId: 'F2.S2', line: null } });
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Charge the fee' })).toBeNull();
    expect(box(2).className).not.toContain('peeked');
  });

  it('Close and "← Map" end the peek', async () => {
    const { onPeek } = show({ peek: peekAt('F1.S2') });
    await screen.findByText('five');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onPeek).toHaveBeenLastCalledWith(null);
    onPeek.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '← Map' }));
    expect(onPeek).toHaveBeenLastCalledWith(null);
  });

  it('a move inside the peek peeks there', async () => {
    const { onPeek } = show({ peek: peekAt('F1.S1') });
    fireEvent.click(await screen.findByRole('button', { name: 'six' }));
    expect(onPeek).toHaveBeenLastCalledWith({ flowId: 'F1', stepId: 'F1.S2', line: null });
  });

  it('arrow keys move the divider, within its bounds, and it is remembered', () => {
    show({ peek: peekAt('F1.S2') });
    const divider = screen.getByRole('separator');
    fireEvent.keyDown(divider, { key: 'ArrowDown' });
    expect(divider.getAttribute('aria-valuenow')).toBe('45');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ panel: 0.45 });
    for (let i = 0; i < 20; i++) fireEvent.keyDown(divider, { key: 'ArrowUp' });
    expect(divider.getAttribute('aria-valuenow')).toBe('15');
  });

  it('starts from the remembered split', () => {
    localStorage.setItem(KEY, JSON.stringify({ panel: 0.7, card: 0.5 }));
    show({ peek: peekAt('F1.S2') });
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('70');
  });

  it('in a card the peek gets the remembered height, 60vh by default', () => {
    const { view } = show({ place: 'card', peek: peekAt('F1.S2') });
    const root = view.container.querySelector<HTMLElement>('.map-peek')!;
    expect(root.style.getPropertyValue('--peek-height')).toBe('60vh');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' });
    expect(root.style.getPropertyValue('--peek-height')).toBe('65vh');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ card: 0.65 });
  });

  it('storage that holds "x" falls back to the defaults', () => {
    localStorage.setItem(KEY, 'x');
    const { view } = show({ peek: peekAt('F1.S2') });
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('40');
    view.unmount();
    show({ place: 'card', peek: peekAt('F1.S2') });
    const root = document.querySelector<HTMLElement>('.map-peek')!;
    expect(root.style.getPropertyValue('--peek-height')).toBe('60vh');
  });

  it('out-of-range stored values fall back to the defaults', () => {
    localStorage.setItem(KEY, JSON.stringify({ panel: 3, card: 'big' }));
    show({ peek: peekAt('F1.S2') });
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('40');
  });

  it('storage that throws still renders with the defaults, and moving still works', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    show({ peek: peekAt('F1.S2') });
    const divider = screen.getByRole('separator');
    expect(divider.getAttribute('aria-valuenow')).toBe('40');
    fireEvent.keyDown(divider, { key: 'ArrowDown' });
    expect(divider.getAttribute('aria-valuenow')).toBe('45');
    // The split kept in memory lasts until a save works: one does, so no other test sees it.
    vi.restoreAllMocks();
    fireEvent.keyDown(divider, { key: 'ArrowUp' });
    expect(divider.getAttribute('aria-valuenow')).toBe('40');
  });

  it('when saving fails but reading works, the divider keeps its new place', () => {
    localStorage.setItem(KEY, JSON.stringify({ panel: 0.4, card: 0.6 }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    function ui() {
      return (
        <MapWithPeek
          place="panel"
          flow={makeFlow()}
          currentId="F1.S1"
          peek={peekAt('F1.S2')}
          peekProps={{
            repo: 'acme/loans',
            pr: 42,
            tour: makeTour([makeFlow()]),
            keys: true,
            review: fakeReview(),
            isSeen: () => false,
            onMarkSeen: vi.fn(),
            onOpenInTour: vi.fn(),
          }}
          onPeek={vi.fn()}
        />
      );
    }
    const { view } = show({ peek: peekAt('F1.S2') });
    const value = () => screen.getByRole('separator').getAttribute('aria-valuenow');
    // Any new render reads the split again.
    const renderAgain = () => view.rerender(ui());
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' });
    expect(value()).toBe('45');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' });
    expect(value()).toBe('50');
    renderAgain();
    // Not the older stored 0.4.
    expect(value()).toBe('50');

    // Once a save works, what is stored counts again.
    setItem.mockRestore();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ panel: 0.55 });
    localStorage.setItem(KEY, JSON.stringify({ panel: 0.3, card: 0.6 }));
    renderAgain();
    expect(value()).toBe('30');
  });

  it('dragging the divider sets the split', () => {
    const { view } = show({ peek: peekAt('F1.S2') });
    const root = view.container.querySelector<HTMLElement>('.map-peek')!;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      height: 1000,
      bottom: 1100,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    const divider = screen.getByRole('separator');
    fireEvent.pointerDown(divider, { clientY: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(divider, { clientY: 700, pointerId: 1 });
    fireEvent.pointerUp(divider, { clientY: 700, pointerId: 1 });
    expect(divider.getAttribute('aria-valuenow')).toBe('60');
    expect(root.style.getPropertyValue('--map-share')).toBe('0.6');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ panel: 0.6 });
  });

  describe('several maps on screen', () => {
    /** Two maps side by side, as the map panel and the overview cards are. */
    function showTwo(places: [Props['place'], Props['place']], peeks: (PeekState | null)[]) {
      const flows = [makeFlow('F1'), makeFlow('F2')];
      const tour = makeTour(flows);
      const ui = (p: (PeekState | null)[]) => (
        <>
          {flows.map((flow, i) => (
            <MapWithPeek
              key={flow.id}
              place={places[i]!}
              flow={flow}
              currentId={`${flow.id}.S1`}
              peek={p[i] ?? null}
              peekProps={{
                repo: 'acme/loans',
                pr: 42,
                tour,
                keys: false,
                review: fakeReview(),
                isSeen: () => false,
                onMarkSeen: vi.fn(),
                onOpenInTour: vi.fn(),
              }}
              onPeek={vi.fn()}
            />
          ))}
        </>
      );
      const view = render(ui(peeks));
      const roots = () => [...view.container.querySelectorAll<HTMLElement>('.map-peek')];
      return { rerender: (p: (PeekState | null)[]) => view.rerender(ui(p)), roots };
    }
    const at = (flowId: string): PeekState => ({ flowId, stepId: `${flowId}.S2`, line: null });
    const stored = () => JSON.parse(localStorage.getItem(KEY)!) as unknown;

    it('a card resized in one card is the size a peek opened later in another card gets', () => {
      const { rerender, roots } = showTwo(['card', 'card'], [at('F1'), null]);
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' });
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' });
      expect(stored()).toEqual({ panel: 0.4, card: 0.7 });
      rerender([null, at('F2')]);
      expect(roots()[1]!.style.getPropertyValue('--peek-height')).toBe('70vh');
    });

    it('the panel and a card each keep their own size', () => {
      const { rerender } = showTwo(['panel', 'card'], [null, at('F2')]);
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' });
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' });
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' });
      expect(stored()).toEqual({ panel: 0.4, card: 0.75 });

      rerender([at('F1'), null]);
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' });
      // The panel's save leaves the card's height alone.
      expect(stored()).toEqual({ panel: 0.45, card: 0.75 });

      rerender([null, at('F2')]);
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' });
      expect(stored()).toEqual({ panel: 0.45, card: 0.7 });
    });

    it('a size stored after the maps were drawn is used when a peek opens', () => {
      const { rerender, roots } = showTwo(['panel', 'card'], [null, null]);
      localStorage.setItem(KEY, JSON.stringify({ panel: 0.3, card: 0.8 }));
      rerender([at('F1'), null]);
      expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('30');
      rerender([null, at('F2')]);
      expect(roots()[1]!.style.getPropertyValue('--peek-height')).toBe('80vh');
    });
  });
});
