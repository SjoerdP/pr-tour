// Navigation areas (outline, step bar, top bar) carry this mark: a click in them moves
// through the tour and leaves the review panel open. Other clicks outside it close it.

const ATTRIBUTE = 'data-keeps-review-open';

/** Spread onto a navigation area's element. */
export const keepsReviewOpen = { [ATTRIBUTE]: '' };

/** True when `target` sits in a marked navigation area. */
export function inKeepOpenArea(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${ATTRIBUTE}]`) !== null;
}
