import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OtherGroup, Tour } from '../../src/shared/tour.js';
import * as api from '../../src/web/api.js';
import { TourView } from '../../src/web/TourView.js';
import { response, tour as baseTour } from './tour-fixture.js';

// The outline: sections with progress, the foundations card, one card per flow (only the
// current one open) and one row per other-changes group.

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

function outline(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Tour outline' });
}

function item(title: string): HTMLElement {
  return within(outline()).getByRole('button', { name: new RegExp(title) });
}

/** The header button of a card or group: its name starts with the title (after a number). */
function toggle(title: string): HTMLElement {
  return within(outline()).getByRole('button', { name: new RegExp(`^(\\d+ )?${title}`) });
}

function currentTitle(): string {
  return within(outline()).getByRole('button', { current: 'step' }).textContent ?? '';
}

async function open(tour: Tour = baseTour) {
  getPr.mockResolvedValue(response({ tour }));
  render(<TourView repo="acme/loans" pr={42} />);
  await screen.findByRole('navigation', { name: 'Tour outline' });
}

beforeEach(() => {
  markSeen.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('outline sections', () => {
  it('each section heading shows how many of its reviewable homes are seen', async () => {
    getPr.mockResolvedValue(response({ seen: { 'F1.S1': 'h-11' } }));
    render(<TourView repo="acme/loans" pr={42} />);
    await screen.findByRole('navigation', { name: 'Tour outline' });

    const progress = within(outline())
      .getAllByRole('heading', { level: 2 })
      .map((h) => `${h.textContent} ${h.nextElementSibling?.textContent}`);
    expect(progress).toEqual([
      'Foundations 0 / 1 seen',
      'Flows 1 / 2 seen',
      'Other changes 0 / 1 seen',
    ]);
  });

  it('shows no "changed" pill and no check marks', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });

    expect(within(outline()).queryByText('changed')).toBeNull();
    expect(within(outline()).queryByText('✓')).toBeNull();
  });

  it('a seen step keeps its place and says seen to assistive tech', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: 'j' });

    const seen = item('Parse the request');
    expect(within(seen).getByLabelText('seen')).toBeTruthy();
    expect(seen.closest('li')!.className).toContain('seen');
  });

  it('a long step title is in the item tooltip', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });
    expect(item('Record the repayment').title).toBe('Record the repayment');
  });
});

describe('foundations card', () => {
  it('is open while a foundation is current and closes when the reader moves on', async () => {
    await open();
    expect(toggle('Migration').getAttribute('aria-expanded')).toBe('true');
    expect(item('Create repayments table').getAttribute('aria-current')).toBe('step');

    fireEvent.keyDown(window, { key: 'j' });
    expect(toggle('Migration').getAttribute('aria-expanded')).toBe('false');
    expect(within(outline()).queryByText('Create repayments table')).toBeNull();

    fireEvent.keyDown(window, { key: 'k' });
    expect(toggle('Migration').getAttribute('aria-expanded')).toBe('true');
  });

  it('closed, it shows the item count and how many to read closely', async () => {
    const tour: Tour = {
      ...baseTour,
      foundations: [
        { ...baseTour.foundations[0]!, risk: 'read-closely' },
        { ...baseTour.foundations[0]!, id: 'f2', kind: 'config', title: 'Add a setting' },
      ],
    };
    await open(tour);
    fireEvent.keyDown(window, { key: ']' });

    const head = toggle('Migration, config');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('2 items');
    expect(head.textContent).toContain('1 read closely');
  });

  it('can be opened by hand while reading a flow', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'j' });

    fireEvent.click(toggle('Migration'));
    expect(toggle('Migration').getAttribute('aria-expanded')).toBe('true');
    expect(item('Create repayments table')).toBeTruthy();
  });
});

describe('flow cards', () => {
  it('only the flow with the current step is open', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });

    expect(toggle('Repay a loan').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Notify the lender').getAttribute('aria-expanded')).toBe('false');
    expect(within(outline()).queryByText('Pick the lender')).toBeNull();
    expect(within(outline()).getByText('POST /F1')).toBeTruthy();
  });

  it('a closed card shows its number, title and progress', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });

    expect(toggle('Notify the lender').textContent).toMatch(/^2\s*Notify the lender/);
    expect(toggle('Repay a loan').textContent).toContain('0 / 2');
  });

  it('moving into another flow opens it and closes the previous one', async () => {
    await open();
    fireEvent.click(toggle('Migration'));
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: ']' });
    expect(currentTitle()).toContain('Pick the lender');
    expect(toggle('Notify the lender').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Repay a loan').getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(window, { key: 'k' });
    expect(currentTitle()).toContain('Return the response');
    expect(toggle('Repay a loan').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Notify the lender').getAttribute('aria-expanded')).toBe('false');
  });

  it('opening another card by hand closes the open one; the choice holds inside the flow', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });

    fireEvent.click(toggle('Notify the lender'));
    expect(toggle('Notify the lender').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Repay a loan').getAttribute('aria-expanded')).toBe('false');

    // j stays in flow 1: the hand-made choice stands.
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByTestId('code-view').textContent).toBe('F1.S2');
    expect(toggle('Repay a loan').getAttribute('aria-expanded')).toBe('false');

    // ] crosses into flow 2: back to "the current flow is open".
    fireEvent.keyDown(window, { key: ']' });
    expect(toggle('Notify the lender').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Repay a loan').getAttribute('aria-expanded')).toBe('false');
  });

  it('the current card can be closed by hand', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });

    fireEvent.click(toggle('Repay a loan'));
    expect(toggle('Repay a loan').getAttribute('aria-expanded')).toBe('false');
    expect(within(outline()).queryByText('Parse the request')).toBeNull();
  });

  it('steps show side effects as short words, repeated ones counted', async () => {
    const tour = structuredClone(baseTour);
    tour.flows[0]!.steps[0]!.sideEffects = [
      { kind: 'db-write', label: 'INSERT repayments' },
      { kind: 'db-write', label: 'UPDATE loans' },
      { kind: 'external-call', label: 'POST bank' },
    ];
    await open(tour);
    fireEvent.keyDown(window, { key: ']' });

    const words = within(item('Parse the request')).getAllByTitle(/./);
    expect(words.map((w) => w.textContent)).toEqual(['db ×2', 'ext']);
    expect(words[0]!.title).toBe('INSERT repayments; UPDATE loans');
  });

  it('read closely shows as a word only on the current step', async () => {
    const tour = structuredClone(baseTour);
    tour.flows[0]!.steps[0]!.risk = 'read-closely';
    tour.flows[0]!.steps[2]!.risk = 'read-closely';
    await open(tour);
    fireEvent.keyDown(window, { key: ']' });

    expect(within(item('Parse the request')).getByText('read closely').className).not.toContain(
      'sr-only',
    );
    const other = within(item('Record the repayment')).getByText('read closely');
    expect(other.className).toContain('sr-only');
    expect(other.parentElement!.title).toBe('Read closely');
  });

  it('unchanged context steps are marked unchanged', async () => {
    await open();
    fireEvent.keyDown(window, { key: ']' });

    expect(within(item('Load the loan')).getByLabelText('unchanged')).toBeTruthy();
    expect(within(item('Parse the request')).queryByLabelText('unchanged')).toBeNull();
  });

  it('Previous flow and Next flow sit in the outline', async () => {
    await open();
    expect(within(outline()).getByRole('button', { name: 'Next flow' }).title).toBe(
      'Next flow (])',
    );
    expect(within(outline()).getByRole('button', { name: 'Previous flow' }).title).toBe(
      'Previous flow ([)',
    );
  });
});

describe('other changes groups', () => {
  function groupOf(kind: OtherGroup['kind'], title: string, itemTitle: string): OtherGroup {
    return {
      kind,
      title,
      summary: `About ${title}.`,
      items: [{ id: `${kind}1`, file: `${kind}.ts`, title: itemTitle, homes: [] }],
    };
  }

  it('one row per group with its count; generated says skim; unexplained first and a warning', async () => {
    const tour: Tour = {
      ...baseTour,
      other: [
        ...baseTour.other,
        groupOf('generated', 'Generated', 'Lockfile'),
        groupOf('unexplained', 'Unexplained', 'src/x.ts lines 1–2'),
      ],
    };
    await open(tour);

    const rows = within(outline())
      .getAllByRole('button')
      .filter((b) => b.classList.contains('card-toggle') && b.closest('.outline-group'));
    expect(rows.map((r) => r.textContent)).toEqual([
      'Unexplained 1',
      'Tests 1',
      'Generated skim 1',
    ]);
    expect(rows[0]!.closest('.outline-group')!.className).toContain('outline-group-unexplained');
    // The unexplained group is a warning: open from the start. The others start shut.
    expect(rows.map((r) => r.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false']);
    expect(within(outline()).getByText('src/x.ts lines 1–2')).toBeTruthy();
    expect(within(outline()).queryByText('Lockfile')).toBeNull();
  });

  it('a group opens on click to its summary and items', async () => {
    await open();

    fireEvent.click(toggle('Tests'));
    expect(toggle('Tests').getAttribute('aria-expanded')).toBe('true');
    expect(within(outline()).getByText('Tests for repay.')).toBeTruthy();
    fireEvent.click(item('Repay tests'));
    expect(currentTitle()).toContain('Repay tests');
  });

  it('card and group toggles point aria-controls only at what is shown', async () => {
    await open();
    for (const toggle of within(outline()).getAllByRole('button', { expanded: false })) {
      expect(toggle.hasAttribute('aria-controls')).toBe(false);
    }
    for (const toggle of within(outline()).getAllByRole('button', { expanded: true })) {
      expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy();
    }
  });

  it('a group opens by itself when the reader moves into it', async () => {
    await open();
    for (let i = 0; i < 8; i++) fireEvent.keyDown(window, { key: 'j' });

    expect(currentTitle()).toContain('Repay tests');
    expect(toggle('Tests').getAttribute('aria-expanded')).toBe('true');
  });
});
