import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlacedProblem } from '../../src/shared/problems.js';
import type { Tour } from '../../src/shared/tour.js';
import type { PeekState } from '../../src/web/MapWithPeek.js';
import { Overview } from '../../src/web/Overview.js';
import {
  EMPTY_PROBLEMS,
  ProblemsContext,
  type ProblemsValue,
} from '../../src/web/ProblemsContext.js';
import { fakeReview } from './review-fake.js';
import { tour as baseTour } from './tour-fixture.js';

// The real code view loads files; a peek's code is not what these tests are about.
vi.mock('../../src/web/CodeView.js', () => ({
  CodeView: ({ homeId }: { homeId: string }) => <div data-testid="code-view">{homeId}</div>,
}));

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

function show(
  props: {
    tour?: Tour;
    started?: boolean;
    currentId?: string | null;
    peek?: PeekState | null;
    hidden?: boolean;
    problems?: Partial<ProblemsValue>;
  } = {},
) {
  const onStart = vi.fn();
  const onVisit = vi.fn();
  const onPeek = vi.fn();
  const onMarkSeen = vi.fn();
  const shown = props.tour ?? tour;
  render(
    <WithProblems value={props.problems ?? {}}>
      <Overview
        tour={shown}
        title="Early repayment"
        started={props.started ?? false}
        currentId={props.currentId ?? null}
        onStart={onStart}
        peek={props.peek ?? null}
        onPeek={onPeek}
        peekProps={{
          repo: 'acme/loans',
          pr: 42,
          tour: shown,
          keys: true,
          review: fakeReview(),
          isSeen: () => false,
          onMarkSeen,
        }}
        onVisit={onVisit}
        {...(props.hidden !== undefined && { hidden: props.hidden })}
      />
    </WithProblems>,
  );
  return { onStart, onVisit, onPeek, onMarkSeen };
}

/** Gives the overview these problems; marks set by its buttons are kept, as the hook does. */
function WithProblems({ value, children }: { value: Partial<ProblemsValue>; children: ReactNode }) {
  const [marks, setMarks] = useState<Record<string, 'real' | 'not'>>({});
  const given = { ...EMPTY_PROBLEMS, ...value };
  return (
    <ProblemsContext.Provider
      value={{
        ...given,
        markOf: (key) => marks[key] ?? given.markOf(key),
        setMark: (key, mark) => {
          given.setMark(key, mark);
          setMarks((prev) => {
            const next = { ...prev };
            if (mark === null) delete next[key];
            else next[key] = mark;
            return next;
          });
        },
      }}
    >
      {children}
    </ProblemsContext.Provider>
  );
}

function problem(
  key: string,
  level: PlacedProblem['level'],
  at: PlacedProblem['at'],
  homeId: string | null,
  more: Partial<PlacedProblem> = {},
): PlacedProblem {
  return { key, level, title: `Title ${key}`, sources: ['CodeRabbit'], at, homeId, ...more };
}

const line = (file: string, n: number) => ({
  kind: 'line' as const,
  file,
  side: 'new' as const,
  line: n,
});

/** Sorted as the hook sorts them: worst first, PR-wide first, then tour order. */
const PROBLEMS: PlacedProblem[] = [
  problem('ci', 'bug', { kind: 'pr' }, null, {
    title: 'CI check "build" fails',
    sources: ['CI tests'],
    url: 'https://github.com/acme/loans/actions/runs/1',
  }),
  problem('fee', 'bug', line('src/a.ts', 4), 'F1.S1', {
    title: 'The fee is charged twice.',
    why: 'Both branches call chargeFee.',
    sources: ['CodeRabbit', 'golangci-lint'],
  }),
  problem('table', 'risk', { kind: 'file', file: 'm.sql' }, 'f1'),
  problem('name', 'look', line('test/repay.test.ts', 2), 'o1.1'),
  problem('other', 'look', line('test/repay.test.ts', 5), 'o1.1'),
];

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
    const { onVisit } = show();
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
    // A step in the strip is a visit: shown in the tour, with a way back here.
    fireEvent.click(within(strip).getByRole('button', { name: '1 Parse the request' }));
    expect(onVisit).toHaveBeenCalledWith('F1.S1');

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

  it('a map click peeks at the step, and moves nothing in the tour', () => {
    const { onVisit, onPeek } = show();
    const map = screen.getByRole('region', { name: 'Flow 1 map' });
    fireEvent.click(within(map).getByText('Step 2').closest('button')!);
    expect(onPeek).toHaveBeenCalledWith({ flowId: 'F1', stepId: 'F1.S2', line: null });
    expect(onVisit).not.toHaveBeenCalled();
  });

  it("shows the peek in its flow's card, titled under the card heading", () => {
    const { onVisit, onMarkSeen } = show({ peek: { flowId: 'F1', stepId: 'F1.S2', line: null } });
    const first = card('Flow 1 · Repay a loan');
    const title = within(first).getByRole('heading', { level: 5, name: 'Load the loan' });
    const peek = title.closest('section')!;
    expect(within(peek).getByTestId('code-view').textContent).toBe('F1.S2');

    fireEvent.click(within(peek).getByRole('button', { name: 'Open in tour' }));
    expect(onVisit).toHaveBeenCalledWith('F1.S2');
    fireEvent.click(within(peek).getByRole('button', { name: 'Mark as seen' }));
    expect(onMarkSeen).toHaveBeenCalledWith('F1.S2');
  });

  it('can be kept but hidden', () => {
    show({ hidden: true });
    expect(screen.queryByRole('region', { name: 'Overview' })).toBeNull();
    expect(screen.getAllByRole('button', { hidden: true, name: 'Start the tour' })).toHaveLength(2);
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

  it('lists the rest of the PR, each a visit', () => {
    const { onVisit } = show();
    expect(screen.getByText('Also in this PR')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 foundation' }));
    expect(onVisit).toHaveBeenCalledWith('f1');
    fireEvent.click(screen.getByRole('button', { name: 'Tests (1)' }));
    expect(onVisit).toHaveBeenCalledWith('o1.1');
  });

  it('the dots between the rest of the PR are not read aloud', () => {
    show();
    const rest = screen.getByText('Also in this PR').parentElement!;
    const dots = Array.from(rest.querySelectorAll('.overview-rest-sep'));
    // Two parts (the foundation and the tests): one dot between them.
    expect(dots).toHaveLength(1);
    expect(dots[0]!.textContent).toBe('·');
    expect(dots[0]!.getAttribute('aria-hidden')).toBe('true');
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

  it('lists possible problems worst first with counts', () => {
    show({ problems: { problems: PROBLEMS } });
    const block = screen.getByRole('region', { name: 'Possible problems (5)' });
    // Above the flows.
    const flows = screen.getByRole('region', { name: 'Flows in this PR (2)' });
    expect(block.compareDocumentPosition(flows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(block).getByText('2 likely bugs · 1 risk · 2 worth a look')).toBeTruthy();
    const cards = within(block).getAllByRole('listitem');
    expect(cards.map((c) => c.querySelector('.problem-title')!.textContent)).toEqual([
      'CI check "build" fails',
      'The fee is charged twice.',
      'Title table',
      'Title name',
      'Title other',
    ]);
    const fee = cards[1]!;
    expect(within(fee).getByText('Likely bug')).toBeTruthy();
    expect(within(fee).getByText('Both branches call chargeFee.')).toBeTruthy();
    expect(within(fee).getByText('CodeRabbit')).toBeTruthy();
    expect(within(fee).getByText('golangci-lint')).toBeTruthy();
    expect(
      within(fee).getByRole('button', { name: 'Flow 1 · step 1 · Parse the request, line 4' }),
    ).toBeTruthy();
    for (const name of ['Real problem', 'Not a problem']) {
      expect(within(fee).getByRole('button', { name }).getAttribute('aria-pressed')).toBe('false');
    }
    expect(within(cards[2]!).getByText('Risk')).toBeTruthy();
    expect(
      within(cards[2]!).getByRole('button', {
        name: 'Foundation · migration · Create repayments table',
      }),
    ).toBeTruthy();
    expect(within(cards[3]!).getByText('Worth a look')).toBeTruthy();
    // A PR-wide problem has no place to go; its title links to the CI run.
    const ci = cards[0]!;
    const link = within(ci).getByRole('link', { name: 'CI check "build" fails' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/loans/actions/runs/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(within(ci).queryByRole('button', { name: /Flow|Foundation|line/ })).toBeNull();
  });

  it('a where-link opens the home as a visit', () => {
    const { onVisit } = show({ problems: { problems: PROBLEMS } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Flow 1 · step 1 · Parse the request, line 4' }),
    );
    expect(onVisit).toHaveBeenLastCalledWith('F1.S1', { file: 'src/a.ts', line: 4 });
    // No line: the home opens at its start.
    fireEvent.click(
      screen.getByRole('button', { name: 'Foundation · migration · Create repayments table' }),
    );
    expect(onVisit).toHaveBeenLastCalledWith('f1');
    fireEvent.click(
      screen.getByRole('button', { name: 'Other changes · Tests · Repay tests, line 2' }),
    );
    expect(onVisit).toHaveBeenLastCalledWith('o1.1', { file: 'test/repay.test.ts', line: 2 });
  });

  it('Not a problem dims the card and moves it down', () => {
    const setMark = vi.fn();
    show({ problems: { problems: PROBLEMS, setMark } });
    const block = screen.getByRole('region', { name: 'Possible problems (5)' });
    const titles = () =>
      within(block)
        .getAllByRole('listitem')
        .map((c) => c.querySelector('.problem-title')!.textContent);
    const name = within(block).getAllByRole('listitem')[3]!;
    const not = within(name).getByRole('button', { name: 'Not a problem' });
    fireEvent.click(not);
    expect(setMark).toHaveBeenLastCalledWith('name', 'not');
    expect(not.getAttribute('aria-pressed')).toBe('true');
    expect(name.className).toContain('problem-not');
    // At the end of its level, still above nothing worse.
    expect(titles()).toEqual([
      'CI check "build" fails',
      'The fee is charged twice.',
      'Title table',
      'Title other',
      'Title name',
    ]);
    // Real problem: shown as pressed; the card is not dimmed.
    fireEvent.click(within(name).getByRole('button', { name: 'Real problem' }));
    expect(setMark).toHaveBeenLastCalledWith('name', 'real');
    expect(name.className).not.toContain('problem-not');
    expect(
      within(name).getByRole('button', { name: 'Real problem' }).getAttribute('aria-pressed'),
    ).toBe('true');
    // A second click takes the mark away.
    fireEvent.click(within(name).getByRole('button', { name: 'Real problem' }));
    expect(setMark).toHaveBeenLastCalledWith('name', null);
  });

  it('lists unplaced line problems under Elsewhere in this PR', () => {
    const { onVisit } = show({
      problems: {
        problems: [
          problem('fee', 'bug', line('src/a.ts', 4), 'F1.S1'),
          problem('far', 'risk', line('src/b.ts', 7), null, { title: 'Nil map write' }),
        ],
      },
    });
    const block = screen.getByRole('region', { name: 'Possible problems (2)' });
    const elsewhere = within(block).getByRole('region', { name: 'Elsewhere in this PR' });
    const far = within(elsewhere).getByRole('listitem');
    expect(within(far).getByText('Nil map write')).toBeTruthy();
    expect(within(far).getByText('src/b.ts, line 7')).toBeTruthy();
    expect(within(elsewhere).queryByText('Title fee')).toBeNull();
    fireEvent.click(within(far).getByText('src/b.ts, line 7'));
    expect(onVisit).not.toHaveBeenCalled();
  });

  it('says when nothing was found', () => {
    show({ problems: { problems: [] } });
    const block = screen.getByRole('region', { name: 'Possible problems' });
    expect(within(block).getByText('No possible problems found.')).toBeTruthy();
    expect(within(block).getByText('Read: CI checks and review bots.').className).toContain(
      'muted',
    );
  });

  it('when CI could not be read, says only the review bots were read', () => {
    show({ problems: { problems: [], note: 'Could not read CI results from GitHub: x' } });
    const block = screen.getByRole('region', { name: 'Possible problems' });
    expect(within(block).getByText('No possible problems found.')).toBeTruthy();
    expect(within(block).getByText('Read: review bots.').className).toContain('muted');
    expect(within(block).queryByText('Read: CI checks and review bots.')).toBeNull();
  });

  it('a problem on a deleted line names its home without the line', () => {
    const { onVisit } = show({
      problems: {
        problems: [
          problem(
            'gone',
            'look',
            { kind: 'line', file: 'src/a.ts', side: 'old', line: 4 },
            'F1.S1',
          ),
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flow 1 · step 1 · Parse the request' }));
    expect(onVisit).toHaveBeenLastCalledWith('F1.S1');
  });

  it('shows the outdated and pending notes', () => {
    show({
      problems: {
        problems: [],
        pending: true,
        outdated: true,
        note: 'Could not read CI results from GitHub: rate limited',
      },
    });
    const block = screen.getByRole('region', { name: 'Possible problems' });
    for (const text of [
      'CI is still running; more may come.',
      'CI results of newer commits are not shown until the tour is rebuilt.',
      'Could not read CI results from GitHub: rate limited',
    ]) {
      expect(within(block).getByText(text).className).toContain('muted');
    }
  });

  it('says while CI results are read, and not yet that none were found', () => {
    show({ problems: { problems: [], loading: true } });
    const block = screen.getByRole('region', { name: 'Possible problems' });
    expect(within(block).getByText('Reading CI results…')).toBeTruthy();
    expect(within(block).queryByText('No possible problems found.')).toBeNull();
  });

  it('shows why a mark was not saved', () => {
    show({ problems: { problems: PROBLEMS, error: 'Could not save the mark: disk full' } });
    expect(screen.getByRole('status').textContent).toBe('Could not save the mark: disk full');
  });
});
