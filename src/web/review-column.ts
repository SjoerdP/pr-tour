// When the review panel gets a column of its own instead of lying over the code. The
// stylesheet's `@media` for `.review-open` uses this same query (a test checks they match).

export const REVIEW_COLUMN_QUERY = '(min-width: 1300px)';

/** True when the window is wide enough for the review panel's column. */
export function isReviewColumn(): boolean {
  return window.matchMedia?.(REVIEW_COLUMN_QUERY).matches ?? false;
}
