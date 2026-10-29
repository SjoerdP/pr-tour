import { screen } from '@testing-library/react';

/**
 * The rows of the open step's "how did we get here" block, as `Label: content`; each line
 * of the content cell joined with a space. Empty when the step has no block.
 */
export function cameFromRows(): string[] {
  const block = screen.queryByTestId('came-from');
  if (!block) return [];
  return [...block.querySelectorAll('.came-from-row')].map((row) => {
    const label = row.querySelector('.came-from-label')?.textContent ?? '';
    const lines = [...row.querySelectorAll('.came-from-body > p')].map((p) => p.textContent);
    return `${label}: ${lines.join(' ')}`;
  });
}
