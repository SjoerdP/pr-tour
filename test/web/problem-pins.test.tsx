import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlacedProblem } from '../../src/shared/problems.js';
import { ProblemPins } from '../../src/web/ProblemPins.js';
import type { ProblemsValue } from '../../src/web/ProblemsContext.js';
import { line, problem, WithProblems } from './problems-fake.js';

// Pins: a coloured dot per possible problem on a step's outline row and map box. A click
// shows the problem in a small popup, with "Go to the line".

function pins(problems: PlacedProblem[], more: Partial<ProblemsValue> = {}) {
  return render(
    <WithProblems value={{ problems, ...more }}>
      <ProblemPins homeId="S1" />
      <button type="button">Outside</button>
    </WithProblems>,
  );
}

function dots(): string[] {
  return screen
    .queryAllByRole('button')
    .filter((b) => b.classList.contains('problem-pin'))
    .map((b) => b.getAttribute('aria-label') ?? '');
}

describe('ProblemPins', () => {
  it('one dot per problem on its home, worst first, coloured by level', () => {
    pins([
      problem('a', 'look', line('src/a.ts', 3), 'S1'),
      problem('b', 'bug', line('src/a.ts', 4), 'S1'),
      problem('c', 'risk', line('src/a.ts', 5), 'S2'),
    ]);
    expect(dots()).toEqual(['Likely bug: Title b', 'Worth a look: Title a']);
    const classes = (name: string) => [...screen.getByRole('button', { name }).classList];
    expect(classes('Likely bug: Title b')).toEqual(['problem-pin', 'problem-bug']);
    expect(classes('Worth a look: Title a')).toEqual(['problem-pin', 'problem-look']);
  });

  it('shows nothing for a home without problems', () => {
    const { container } = pins([problem('c', 'risk', line('src/a.ts', 5), 'S2')]);
    expect(container.querySelector('.problem-pins')).toBeNull();
  });

  it('shows at most 3 dots, then +N', () => {
    pins(['a', 'b', 'c', 'd', 'e'].map((k) => problem(k, 'risk', line('src/a.ts', 3), 'S1')));
    expect(dots()).toEqual([
      'Risk: Title a',
      'Risk: Title b',
      'Risk: Title c',
      '2 more possible problems',
    ]);
    expect(screen.getByRole('button', { name: '2 more possible problems' }).textContent).toBe('+2');
    // +N shows the ones it stands for.
    fireEvent.click(screen.getByRole('button', { name: '2 more possible problems' }));
    const popup = screen.getByRole('dialog', { name: 'Possible problems' });
    expect(within(popup).getByText('Title d')).toBeTruthy();
    expect(within(popup).getByText('Title e')).toBeTruthy();
    expect(within(popup).queryByText('Title a')).toBeNull();
  });

  it('a click opens the problem in a popup, read only; a second click closes it', () => {
    pins([problem('a', 'bug', line('src/a.ts', 3), 'S1', { why: 'The fee is never set.' })]);
    const pin = screen.getByRole('button', { name: 'Likely bug: Title a' });
    expect(pin.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(pin);
    const popup = screen.getByRole('dialog', { name: 'Possible problem' });
    expect(pin.getAttribute('aria-expanded')).toBe('true');
    expect(within(popup).getByText('Likely bug')).toBeTruthy();
    expect(within(popup).getByText('Title a')).toBeTruthy();
    expect(within(popup).getByText('The fee is never set.')).toBeTruthy();
    expect(within(popup).queryByRole('button', { name: 'Not a problem' })).toBeNull();
    fireEvent.click(pin);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Go to the line calls onGoTo', () => {
    const onGoTo = vi.fn();
    const p = problem('a', 'bug', line('src/a.ts', 3), 'S1');
    pins([p], { onGoTo });
    fireEvent.click(screen.getByRole('button', { name: 'Likely bug: Title a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to the line' }));
    expect(onGoTo).toHaveBeenCalledWith(p);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a problem about the whole step has no Go to the line', () => {
    pins([problem('a', 'bug', { kind: 'step', test: 'TestRepay' }, 'S1')], { onGoTo: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Likely bug: Title a' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Go to the line' })).toBeNull();
  });

  it('Esc closes the popup and puts focus back on the pin', () => {
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    pins([problem('a', 'bug', line('src/a.ts', 3), 'S1')]);
    const pin = screen.getByRole('button', { name: 'Likely bug: Title a' });
    fireEvent.click(pin);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(pin);
    // The tour's own Esc does not run as well.
    expect(outer).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outer);
  });

  it('a click outside closes the popup', () => {
    pins([problem('a', 'bug', line('src/a.ts', 3), 'S1')]);
    fireEvent.click(screen.getByRole('button', { name: 'Likely bug: Title a' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a problem marked Not a problem has no pin', () => {
    pins(
      [
        problem('a', 'bug', line('src/a.ts', 3), 'S1'),
        problem('b', 'risk', line('src/a.ts', 4), 'S1'),
      ],
      { markOf: (key) => (key === 'a' ? 'not' : key === 'b' ? 'real' : undefined) },
    );
    expect(dots()).toEqual(['Risk: Title b']);
  });
});
