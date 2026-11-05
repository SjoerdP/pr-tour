import { fireEvent, screen } from '@testing-library/react';

// A PR the reader has not started opens on its overview. Tests about the tour itself start
// the tour first, the way a reader would.

/** Clicks "Start the tour" on the overview (the first of its two start buttons). */
export async function startTour(): Promise<void> {
  fireEvent.click((await screen.findAllByRole('button', { name: 'Start the tour' }))[0]!);
}
