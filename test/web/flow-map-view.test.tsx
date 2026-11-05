import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Flow, FlowLink, Step } from '../../src/shared/tour.js';
import { FlowMap } from '../../src/web/FlowMap.js';

// The flow map drawn: boxes for steps, arrow labels for calls, loops, folding and the key.

function step(id: string, extra: Partial<Step> = {}): Step {
  return {
    id,
    title: `Repay ${id}`,
    file: 'loans/repay.go',
    startLine: 1,
    endLine: 50,
    changed: false,
    why: '',
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes: [],
    ...extra,
  };
}

const home = { file: 'loans/repay.go', side: 'new' as const, start: 1, end: 2 };

function flow(steps: Step[], links?: FlowLink[]): Flow {
  return {
    id: 'F1',
    title: 'Repay a loan',
    entry: { kind: 'http', label: 'POST /loans/{id}/repay' },
    steps,
    ...(links && { links }),
  };
}

function link(from: string, to: string, line: number, extra: Partial<FlowLink> = {}): FlowLink {
  return { from, to, line, how: 'call', source: 'both', check: 'proven', ...extra };
}

/** Three steps: S1 calls S2 on line 10, S2 calls S3 on line 20. */
const repay = (links = [link('S1', 'S2', 10), link('S2', 'S3', 20)]) =>
  flow(
    [
      step('S1', { file: 'acme/loans/api/repay.go', homes: [home] }),
      step('S2', {
        title: 'Charge the repay fee',
        file: 'src/fees.ts',
        anchor: { name: 'ChargeFee', startLine: 1, endLine: 30, source: 'symbol' },
        risk: 'read-closely',
        homes: [home, home, home],
        sideEffects: [{ kind: 'db-write', label: 'insert fee' }],
      }),
      step('S3', { file: 'acme/loans/ledger/post.go' }),
    ],
    links,
  );

function show(f: Flow, currentId = 'S1') {
  const onOpenStep = vi.fn();
  const onOpenLine = vi.fn();
  render(
    <FlowMap flow={f} currentId={currentId} onOpenStep={onOpenStep} onOpenLine={onOpenLine} />,
  );
  return { onOpenStep, onOpenLine };
}

/** The box of step `no`. */
function box(no: number): HTMLElement {
  const box = screen.getByText(`Step ${no}`).closest('button');
  if (!box) throw new Error(`no box for step ${no}`);
  return box;
}

/** The box of step `no` with the lines below it (loops, other callers, fold button). */
function card(no: number): HTMLElement {
  return box(no).parentElement!;
}

function key(): HTMLElement {
  return screen.getByRole('list', { name: 'Key' });
}

describe('FlowMap', () => {
  it('shows each step as a box with number, name, file and tags', () => {
    show(repay());
    const s2 = box(2);
    expect(s2.className).toContain('flow-map-box');
    for (const text of ['Step 2', 'ChargeFee', 'src/fees.ts', 'Charge the repay fee']) {
      expect(within(s2).getByText(text)).toBeTruthy();
    }
    expect(within(s2).getByText('3 changes')).toBeTruthy();
    expect(within(s2).getByText('read closely')).toBeTruthy();
    expect(within(s2).getByText('db')).toBeTruthy();
    expect(s2.className).toContain('changed');
    expect(s2.className).toContain('read-closely');
    // The file shows its last two parts; the box without changes says so.
    expect(within(box(3)).getByText('ledger/post.go')).toBeTruthy();
    expect(within(box(3)).getByText('no changes')).toBeTruthy();
    expect(box(3).className).toContain('unchanged');
    expect(screen.getByText('POST /loans/{id}/repay')).toBeTruthy();
    // Plain nested lists: no tree roles, whose keyboard pattern the map does not have.
    const calls = screen.getByRole('list', { name: 'Calls in this flow' });
    expect(within(calls).getByText('Step 3')).toBeTruthy();
    expect(screen.queryAllByRole('tree')).toHaveLength(0);
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });

  it('marks the current step', () => {
    show(repay(), 'S2');
    expect(box(2).getAttribute('aria-current')).toBe('step');
    expect(within(box(2)).getByText('You are here')).toBeTruthy();
    expect(box(1).getAttribute('aria-current')).toBeNull();
    expect(screen.getAllByText('You are here')).toHaveLength(1);
  });

  it('a box click opens the step; an arrow click opens the calling line', () => {
    const { onOpenStep, onOpenLine } = show(repay());
    fireEvent.click(box(3));
    expect(onOpenStep).toHaveBeenCalledWith('S3');
    fireEvent.click(screen.getByRole('button', { name: /^line 20/ }));
    expect(onOpenLine).toHaveBeenCalledWith('S2', 'src/fees.ts', 20);
  });

  it('arrow labels say how the code check backs them up', () => {
    show(
      repay([
        link('S1', 'S2', 10, { check: 'not-found' }),
        link('S2', 'S3', 20, { via: ['buildContext'] }),
      ]),
    );
    const proven = screen.getByRole('button', { name: /^line 20/ });
    expect(proven.className).toContain('flow-map-edge');
    expect(proven.textContent).toContain('via buildContext');
    expect(proven.textContent).toContain('✓ proven');
    expect(proven.className).not.toContain('unproven');
    const notFound = screen.getByRole('button', { name: /^line 10/ });
    expect(notFound.textContent).toContain('not found in the code');
    expect(notFound.className).toContain('unproven');
  });

  it('without links it says the arrows are the tour own claims', () => {
    const f = repay();
    delete f.links;
    f.steps[1]!.from = { step: 1, line: 10, how: 'call' };
    show(f);
    expect(
      screen.getByText(
        "The code check did not run for this flow. The arrows are the tour's own claims.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /^line 10/ }).textContent).toContain('not checked');
  });

  it('without links or from it says the steps are shown in order', () => {
    const f = repay();
    delete f.links;
    show(f);
    expect(
      screen.getByText('The code check did not run. The steps are shown in order.'),
    ).toBeTruthy();
  });

  it('a long flow folds branches without changes', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `S${i + 1}`);
    const steps = ids.map((id) => step(id, id === 'S6' ? { homes: [home] } : {}));
    // S1 calls S2 and S6..S14; S2 calls S3, S4 and S5, none of them changed.
    const links = [
      link('S1', 'S2', 10),
      link('S2', 'S3', 20),
      link('S2', 'S4', 21),
      link('S2', 'S5', 22),
      ...ids.slice(5).map((id, i) => link('S1', id, 30 + i)),
    ];
    show(flow(steps, links));
    expect(screen.queryByText('Step 3')).toBeNull();
    const fold = within(card(2)).getByRole('button', { name: '3 steps below' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    for (const no of [3, 4, 5]) expect(box(no)).toBeTruthy();
    expect(within(card(2)).getByRole('button', { name: 'Hide steps below' })).toBeTruthy();
    // The root has a change below it, so it stays open.
    expect(box(6)).toBeTruthy();
  });

  it('the first step never starts folded, even with no changes below', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `S${i + 1}`);
    // S1 calls every other step; only S1 itself has changes.
    const steps = ids.map((id) => step(id, id === 'S1' ? { homes: [home] } : {}));
    show(
      flow(
        steps,
        ids.slice(1).map((id, i) => link('S1', id, 10 + i)),
      ),
    );
    for (const no of [2, 7, 14]) expect(box(no)).toBeTruthy();
    expect(within(card(1)).getByRole('button', { name: 'Hide steps below' })).toBeTruthy();
  });

  it('an unlinked step never starts folded', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `S${i + 1}`);
    // S2 is not linked; it calls S3..S14, none of them changed.
    show(
      flow(
        ids.map((id) => step(id)),
        ids.slice(2).map((id, i) => link('S2', id, 10 + i)),
      ),
    );
    const row = screen.getByRole('region', { name: 'Not linked to the steps above' });
    expect(within(row).getByText('Step 14')).toBeTruthy();
  });

  it('a folded branch opens when it holds the current step', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `S${i + 1}`);
    const links = [link('S1', 'S2', 10), link('S2', 'S3', 20), link('S2', 'S4', 21)];
    links.push(...ids.slice(4).map((id, i) => link('S1', id, 30 + i)));
    show(
      flow(
        ids.map((id) => step(id)),
        links,
      ),
      'S4',
    );
    expect(box(4).getAttribute('aria-current')).toBe('step');
  });

  it('unlinked steps are listed under their own heading', () => {
    show(repay([link('S1', 'S2', 10)]));
    const row = screen.getByRole('region', { name: 'Not linked to the steps above' });
    expect(within(row).getByText('Step 3')).toBeTruthy();
    expect(within(row).queryByText('Step 2')).toBeNull();
  });

  it('a loop is marked on both boxes and in the key', () => {
    const { onOpenLine } = show(
      repay([link('S1', 'S2', 10), link('S2', 'S3', 20), link('S3', 'S2', 42)]),
    );
    expect(within(box(2)).getByText('↻ Loop')).toBeTruthy();
    expect(within(box(3)).getByText('↻ Loop')).toBeTruthy();
    expect(box(2).className).toContain('in-loop');
    const back = within(card(2)).getByRole('button', {
      name: '↻ Called again from step 3, line 42. Check that the loop stops.',
    });
    fireEvent.click(back);
    expect(onOpenLine).toHaveBeenCalledWith('S3', 'acme/loans/ledger/post.go', 42);
    expect(within(card(3)).getByText('↻ Calls step 2 again on line 42')).toBeTruthy();
    expect(within(key()).getByText('↻ Loop: these steps call each other in a circle')).toBeTruthy();
  });

  it('two siblings that call each other show a loop on both boxes', () => {
    show(
      repay([
        link('S1', 'S2', 10),
        link('S1', 'S3', 11),
        link('S2', 'S3', 20),
        link('S3', 'S2', 30),
      ]),
    );
    expect(within(box(2)).getByText('↻ Loop')).toBeTruthy();
    expect(within(box(3)).getByText('↻ Loop')).toBeTruthy();
    expect(
      within(card(2)).getByRole('button', {
        name: '↻ Called again from step 3, line 30. Check that the loop stops.',
      }),
    ).toBeTruthy();
    expect(within(card(2)).getByText('↻ Calls step 3 again on line 20')).toBeTruthy();
    expect(
      within(card(3)).getByRole('button', {
        name: '↻ Called again from step 2, line 20. Check that the loop stops.',
      }),
    ).toBeTruthy();
    expect(within(card(3)).getByText('↻ Calls step 2 again on line 30')).toBeTruthy();
    expect(screen.queryByText(/Also called from/)).toBeNull();
    expect(within(key()).getByText('↻ Loop: these steps call each other in a circle')).toBeTruthy();
  });

  it('an unproven loop says so', () => {
    show(
      repay([
        link('S1', 'S2', 10),
        link('S2', 'S3', 20),
        link('S3', 'S2', 42, { check: 'unchecked' }),
      ]),
    );
    expect(card(2).textContent).toContain('(not checked)');
    expect(card(3).textContent).toContain('(not checked)');
  });

  it('a step that calls itself says so', () => {
    show(repay([link('S1', 'S2', 10), link('S2', 'S3', 20), link('S2', 'S2', 15)]));
    expect(
      within(card(2)).getByRole('button', {
        name: '↻ Calls itself on line 15. Check that it stops.',
      }),
    ).toBeTruthy();
    expect(within(card(2)).queryByText(/Calls step 2 again/)).toBeNull();
  });

  it('a second caller shows inside the box and opens its line', () => {
    const { onOpenLine } = show(
      repay([
        link('S1', 'S2', 10),
        link('S2', 'S3', 20),
        link('S1', 'S3', 12, { check: 'name-match' }),
      ]),
    );
    fireEvent.click(
      within(card(3)).getByRole('button', { name: 'Also called from step 1, line 12' }),
    );
    expect(onOpenLine).toHaveBeenCalledWith('S1', 'acme/loans/api/repay.go', 12);
  });

  it('no loop line in the key without loops', () => {
    show(repay());
    expect(key().textContent).not.toContain('↻ Loop');
    expect(within(key()).getByText('Blue edge: the step has changes')).toBeTruthy();
  });
});
