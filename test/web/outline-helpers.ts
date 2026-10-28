import { fireEvent, screen, within } from '@testing-library/react';

// The outline shows only the open cards' items. These helpers find an item wherever it is,
// opening the card or group that holds it first, the way a reader would.

export function outline(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Tour outline' });
}

function findItem(name: RegExp): HTMLElement | undefined {
  return within(outline())
    .queryAllByRole('button', { name })
    .find((b) => b.classList.contains('outline-item'));
}

/** The outline entry for the item with this title; opens its card if needed. */
export function outlineItem(title: string): HTMLElement {
  const name = new RegExp(title);
  const visible = findItem(name);
  if (visible) return visible;
  for (const toggle of within(outline()).queryAllByRole('button', { expanded: false })) {
    fireEvent.click(toggle);
    const found = findItem(name);
    if (found) return found;
  }
  throw new Error(`No outline item matches ${String(name)}`);
}

/** The outline card of one flow: its header, entry and steps. */
export function outlineFlow(title: string): HTMLElement {
  return within(outline()).getByRole('heading', { name: new RegExp(title) }).parentElement!;
}

/** The title of the current item. */
export function currentTitle(): string {
  return within(outline()).getByRole('button', { current: 'step' }).textContent ?? '';
}
