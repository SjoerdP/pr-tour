import { render } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { expect, test } from 'vitest';
import { useKeys } from '../../src/web/useKeys.js';

function Keys({ n, seen }: { n: number; seen: number[] }) {
  useKeys({ a: () => seen.push(n) });
  return null;
}

/** Presses `a` during the commit, before passive effects run (like a key right after one). */
function PressDuringCommit({ n }: { n: number }) {
  useLayoutEffect(() => {
    if (n > 0) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  }, [n]);
  return null;
}

test('a key pressed right after a commit runs that render’s handler', () => {
  const seen: number[] = [];
  function Root({ n }: { n: number }) {
    // Siblings commit in order: Keys' layout effects run before the press.
    return (
      <>
        <Keys n={n} seen={seen} />
        <PressDuringCommit n={n} />
      </>
    );
  }
  const { rerender } = render(<Root n={0} />);
  rerender(<Root n={1} />);
  expect(seen).toEqual([1]);
});
