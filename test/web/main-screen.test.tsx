import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';
import { outlineItem } from './outline-helpers.js';
import { response, tour as baseTour } from './tour-fixture.js';

// The main screen around the code: top bar, About panel, step header, extras, bottom bar.

vi.mock('../../src/web/api.js', () => ({
  getPr: vi.fn(),
  buildTour: vi.fn(),
  markSeen: vi.fn(),
  // The tour view loads the PR's review; these tests are not about it: it never arrives.
  getReview: () => new Promise(() => {}),
}));

vi.mock('../../src/web/CodeView.js', () => ({
  CodeView: ({ homeId }: { homeId: string }) => <div data-testid="code-view">{homeId}</div>,
}));

const getPr = vi.mocked(api.getPr);
const markSeen = vi.mocked(api.markSeen);

function facts(): string[] {
  return within(screen.getByRole('list', { name: 'Step facts' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');
}

function trail(): string {
  return screen.getByTestId('step-trail').textContent ?? '';
}

async function open(tour: Tour = baseTour) {
  getPr.mockResolvedValue(response({ tour }));
  const view = render(<TourView repo="acme/loans" pr={42} />);
  await screen.findByRole('navigation', { name: 'Tour outline' });
  return view;
}

beforeEach(() => {
  markSeen.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('top bar', () => {
  it('shows the PR, then flows, progress and where the notes come from', async () => {
    getPr.mockResolvedValue(response({ seen: { 'F1.S1': 'h-11' } }));
    render(<TourView repo="acme/loans" pr={42} />);

    const bar = await screen.findByRole('banner');
    expect(within(bar).getByRole('link', { name: '← Inbox' }).getAttribute('href')).toBe('/');
    expect(within(bar).getByRole('heading', { level: 1 }).textContent).toBe(
      'acme/loans#42 Early repayment',
    );
    expect(within(bar).getByText('2 flows · 1 / 4 seen · notes by the author')).toBeTruthy();
  });

  it('an inferred tour says so', async () => {
    await open({ ...baseTour, source: 'inferred' });
    expect(screen.getByText(/notes inferred by Claude$/)).toBeTruthy();
  });
});

describe('About this PR', () => {
  it('is open on the first visit to a tour and closed on the next', async () => {
    const first = await open();
    const button = screen.getByRole('button', { name: /About this PR/ });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'About this PR' }).textContent).toContain(
      'Adds early repayment.',
    );
    first.unmount();

    await open();
    expect(
      screen.getByRole('button', { name: /About this PR/ }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();
  });

  it('is remembered per PR', async () => {
    localStorage.setItem('pr-tour:about-seen:acme/loans#41', '1');
    await open();
    expect(screen.getByRole('region', { name: 'About this PR' })).toBeTruthy();
  });

  it('opens and closes on click', async () => {
    await open();
    const button = screen.getByRole('button', { name: /About this PR/ });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByRole('region', { name: 'About this PR' })).toBeTruthy();
  });

  it('closes when the reader moves to another step', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /About this PR/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /About this PR/ }));
    fireEvent.click(outlineItem('Create repayments table'));
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();
  });

  it('closes on a click outside it, not on a click inside it', async () => {
    await open();
    const about = screen.getByRole('region', { name: 'About this PR' });
    fireEvent.mouseDown(within(about).getByText('Adds early repayment.'));
    expect(screen.getByRole('region', { name: 'About this PR' })).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId('code-view'));
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();
  });

  it('Close shuts it', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'About this PR' })).toBeNull();
  });

  it('points aria-controls at the panel only while it is shown', async () => {
    await open();
    const button = screen.getByRole('button', { name: /About this PR/ });
    expect(document.getElementById(button.getAttribute('aria-controls')!)).toBeTruthy();
    fireEvent.click(button);
    expect(button.hasAttribute('aria-controls')).toBe(false);
  });

  it('lists check problems', async () => {
    await open({ ...baseTour, check: { problems: ['src/a.ts:3 has two homes'] } });
    const about = screen.getByRole('region', { name: 'About this PR' });
    expect(within(about).getByText('1 check problem')).toBeTruthy();
    expect(within(about).getByText('src/a.ts:3 has two homes')).toBeTruthy();
  });

  it('still works when storage is blocked', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await open();
    expect(screen.getByRole('region', { name: 'About this PR' })).toBeTruthy();
    spy.mockRestore();
  });
});

describe('step header', () => {
  it('a step: trail with flow number and position, title, facts', async () => {
    const tour = structuredClone(baseTour);
    Object.assign(tour.flows[0]!.steps[2]!, {
      risk: 'read-closely',
      riskReason: 'Not in one transaction.',
      sideEffects: [{ kind: 'db-write', label: 'INSERT repayments' }],
      tests: [
        { file: 't.ts', name: 'stores it' },
        { file: 't.ts', name: 'rejects too much' },
      ],
    });
    await open(tour);
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.click(outlineItem('Record the repayment'));

    expect(trail()).toBe('Flow 1 · step 3 of 5');
    expect(screen.getByRole('heading', { level: 2, name: 'Record the repayment' })).toBeTruthy();
    expect(facts()).toEqual(['Read closely', 'writes to DB', '2 tests']);
  });

  it('a changed step without tests says so in its facts', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'j' });
    expect(facts()).toEqual(['no tests cover this step']);
  });

  it('an unchanged step is context', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: ']' });
    expect(trail()).toBe('Flow 2 · step 1 of 2');
    expect(facts()).toEqual(['Unchanged', 'context']);
  });

  it('a step without changed lines is context, never "no tests"', async () => {
    const tour = structuredClone(baseTour);
    tour.flows[0]!.steps[1]!.changed = true;
    await open(tour);
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: 'j' });
    expect(facts()).toEqual(['Unchanged', 'context']);
  });

  it('a foundation and an other item have their own trail', async () => {
    await open();
    expect(trail()).toBe('Foundation · migration');
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: ']' });
    expect(trail()).toBe('Other changes · Tests');
  });

  it('the why note keeps its source label', async () => {
    await open({ ...baseTour, source: 'inferred' });
    expect(screen.getByText('Why · inferred by Claude')).toBeTruthy();
    expect(screen.getByText('Stores repayments.')).toBeTruthy();
  });
});

describe('extras', () => {
  it('why read closely and tests open in place', async () => {
    const tour = structuredClone(baseTour);
    Object.assign(tour.flows[0]!.steps[0]!, {
      risk: 'read-closely',
      riskReason: 'Not in one transaction.',
      tests: [{ file: 't.ts', name: 'stores it' }],
    });
    await open(tour);
    fireEvent.keyDown(window, { key: 'j' });

    expect(screen.queryByText('Not in one transaction.')).toBeNull();
    const why = screen.getByRole('button', { name: 'Why read closely' });
    expect(why.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(why);
    expect(why.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Not in one transaction.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tests (1)' }));
    expect(screen.getByText(/stores it/)).toBeTruthy();
  });

  it('extras close again on the next step', async () => {
    const tour = structuredClone(baseTour);
    tour.flows[0]!.steps[0]!.tests = [{ file: 't.ts', name: 'stores it' }];
    tour.flows[0]!.steps[2]!.tests = [{ file: 't.ts', name: 'records it' }];
    await open(tour);
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.click(screen.getByRole('button', { name: 'Tests (1)' }));
    fireEvent.click(outlineItem('Record the repayment'));
    expect(screen.queryByText('records it')).toBeNull();
  });

  it('the deploy note opens by itself when the change is not compatible', async () => {
    const tour = structuredClone(baseTour);
    tour.foundations[0]!.deployCompat = { ok: false, note: 'Drops a column.' };
    await open(tour);

    expect(
      screen.getByRole('button', { name: 'Deploy compatibility' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText(/Drops a column\./).textContent).toBe(
      'Not compatible: Drops a column.',
    );
    expect(facts()).toContain('not deploy compatible');
  });

  it('a compatible deploy note and the schema stay shut until clicked', async () => {
    const tour = structuredClone(baseTour);
    tour.foundations[0]!.deployCompat = { ok: true, note: 'Additive only.' };
    tour.foundations[0]!.schemaAfter = 'repayments(id uuid pk)';
    await open(tour);

    expect(screen.queryByText(/Additive only\./)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Deploy compatibility' }));
    expect(screen.getByText(/Additive only\./).textContent).toBe('Compatible: Additive only.');
    fireEvent.click(screen.getByRole('button', { name: 'Schema after' }));
    expect(screen.getByText('repayments(id uuid pk)')).toBeTruthy();
  });
});

describe('extras: aria-controls', () => {
  it('points at the opened detail only while it is shown', async () => {
    const tour = structuredClone(baseTour);
    tour.foundations[0]!.schemaAfter = 'repayments(id uuid pk)';
    await open(tour);
    const link = screen.getByRole('button', { name: 'Schema after' });
    expect(link.hasAttribute('aria-controls')).toBe(false);
    fireEvent.click(link);
    expect(document.getElementById(link.getAttribute('aria-controls')!)!.textContent).toBe(
      'repayments(id uuid pk)',
    );
  });
});

describe('bottom bar', () => {
  it('shows the step buttons and the key hints', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next step' }).className).toContain('primary');
    expect(screen.getByText('j / k steps · [ ] flows · n / p changes · f whole file')).toBeTruthy();
  });
});
