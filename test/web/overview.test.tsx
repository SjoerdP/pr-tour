import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Tour } from '../../src/shared/tour.js';
import { Overview } from '../../src/web/Overview.js';
import { tour as baseTour } from './tour-fixture.js';

// The PR overview: title and summary, one card per flow with its step strip and map, the
// rest of the PR in one line, and the start button.

const [repay, notify] = baseTour.flows as [Tour['flows'][0], Tour['flows'][0]];

/** The fixture tour, with a why on the repay flow, a fifth step changed and step 3 read closely. */
const tour: Tour = {
  ...baseTour,
  flows: [
    {
      ...repay,
      entry: { kind: 'http', label: 'POST /loans/{id}/repay' },
      why: 'Lets a borrower pay off a loan early.',
      steps: repay.steps.map((s, i) =>
        i === 2
          ? { ...s, risk: 'read-closely' as const }
          : i === 4
            ? {
                ...s,
                changed: true,
                homes: [{ file: 'src/a.ts', side: 'new' as const, start: 1, end: 2 }],
              }
            : s,
      ),
    },
    notify,
  ],
};

function show(props: { tour?: Tour; started?: boolean; currentId?: string | null } = {}) {
  const onStart = vi.fn();
  const onOpenHome = vi.fn();
  const onOpenLine = vi.fn();
  render(
    <Overview
      tour={props.tour ?? tour}
      title="Early repayment"
      started={props.started ?? false}
      currentId={props.currentId ?? null}
      onStart={onStart}
      onOpenHome={onOpenHome}
      onOpenLine={onOpenLine}
    />,
  );
  return { onStart, onOpenHome, onOpenLine };
}

function card(title: string): HTMLElement {
  return screen.getByRole('region', { name: title });
}

describe('Overview', () => {
  it('shows the title, the summary and a start button', () => {
    const { onStart } = show();
    expect(screen.getByRole('heading', { level: 2, name: 'Early repayment' })).toBeTruthy();
    expect(screen.getByText('Adds early repayment.')).toBeTruthy();
    const starts = screen.getAllByRole('button', { name: 'Start the tour' });
    expect(starts).toHaveLength(2);
    fireEvent.click(starts[0]!);
    fireEvent.click(starts[1]!);
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it('says Continue the tour once started', () => {
    show({ started: true });
    expect(screen.getAllByRole('button', { name: 'Continue the tour' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Start the tour' })).toBeNull();
  });

  it('lists each flow with its entry, why, counts and steps', () => {
    const { onOpenHome } = show();
    expect(screen.getByRole('heading', { level: 3, name: 'Flows in this PR (2)' })).toBeTruthy();
    const first = card('Flow 1 · Repay a loan');
    expect(within(first).getAllByText('POST /loans/{id}/repay').length).toBeGreaterThan(0);
    expect(within(first).getByText('Lets a borrower pay off a loan early.')).toBeTruthy();
    expect(within(first).getByText('5 steps · 3 changed · 1 read closely')).toBeTruthy();
    const strip = within(first).getByRole('list', { name: 'Steps' });
    const steps = within(strip).getAllByRole('button');
    expect(steps.map((b) => b.textContent)).toEqual([
      '1 Parse the request',
      '2 Load the loan',
      '3 Record the repayment',
      '4 Send the receipt',
      '5 Return the response',
    ]);
    expect(steps[0]!.className).toBe('overview-step changed');
    expect(steps[1]!.className).toBe('overview-step unchanged');
    expect(steps[2]!.className).toBe('overview-step changed read-closely');
    fireEvent.click(within(strip).getByRole('button', { name: '1 Parse the request' }));
    expect(onOpenHome).toHaveBeenCalledWith('F1.S1');

    // No read-closely steps: that part of the counts is left out.
    const second = card('Flow 2 · Notify the lender');
    expect(within(second).getByText('2 steps · 0 changed')).toBeTruthy();
  });

  it('opens the first flow map and toggles the others', () => {
    show();
    const first = card('Flow 1 · Repay a loan');
    const second = card('Flow 2 · Notify the lender');
    expect(within(first).getByRole('region', { name: 'Flow 1 map' })).toBeTruthy();
    expect(
      within(first)
        .getByRole('button', { name: 'Hide the map of flow 1' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(within(second).queryByRole('region', { name: 'Flow 2 map' })).toBeNull();

    const toggle = within(second).getByRole('button', { name: 'Show the map of flow 2' });
    expect(toggle.textContent).toBe('Show the map');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(within(second).getByRole('region', { name: 'Flow 2 map' })).toBeTruthy();
    expect(
      within(second)
        .getByRole('button', { name: 'Hide the map of flow 2' })
        .getAttribute('aria-expanded'),
    ).toBe('true');

    fireEvent.click(within(first).getByRole('button', { name: 'Hide the map of flow 1' }));
    expect(within(first).queryByRole('region', { name: 'Flow 1 map' })).toBeNull();
  });

  it('a map click opens the step', () => {
    const { onOpenHome } = show();
    const map = screen.getByRole('region', { name: 'Flow 1 map' });
    fireEvent.click(within(map).getByText('Step 2').closest('button')!);
    expect(onOpenHome).toHaveBeenCalledWith('F1.S2');
  });

  it('the heading of unlinked steps sits under the card heading', () => {
    // Step 1 calls step 2; steps 3 to 5 are not linked.
    const link = {
      from: 'F1.S1',
      to: 'F1.S2',
      line: 10,
      how: 'call',
      source: 'both',
      check: 'proven',
    } as const;
    const linked: Tour = { ...tour, flows: [{ ...repay, links: [link] }] };
    show({ tour: linked });
    const map = screen.getByRole('region', { name: 'Flow 1 map' });
    expect(
      within(map).getByRole('heading', { level: 5, name: 'Not linked to the steps above' }),
    ).toBeTruthy();
  });

  it('lists the rest of the PR', () => {
    const { onOpenHome } = show();
    expect(screen.getByText('Also in this PR')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 foundation' }));
    expect(onOpenHome).toHaveBeenCalledWith('f1');
    fireEvent.click(screen.getByRole('button', { name: 'Tests (1)' }));
    expect(onOpenHome).toHaveBeenCalledWith('o1.1');
  });

  it('a tour without flows has no flows section and can still start', () => {
    const { onStart } = show({ tour: { ...tour, flows: [] } });
    expect(screen.queryByRole('heading', { name: /Flows in this PR/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /the map/ })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Start the tour' })[0]!);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('leaves out the rest line when there is nothing else', () => {
    show({ tour: { ...tour, foundations: [], other: [] } });
    expect(screen.queryByText('Also in this PR')).toBeNull();
  });
});
