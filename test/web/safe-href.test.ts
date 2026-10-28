import { describe, expect, it } from 'vitest';
import { safeHref } from '../../src/web/safe-href.js';

describe('safeHref', () => {
  it('keeps an https URL', () => {
    expect(safeHref('https://github.com/acme/loans/pull/42')).toBe(
      'https://github.com/acme/loans/pull/42',
    );
  });

  it.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'http://ci/1', ''])(
    'refuses %j',
    (url) => {
      expect(safeHref(url)).toBeNull();
    },
  );

  it('refuses a relative URL', () => {
    expect(safeHref('/api/inbox')).toBeNull();
  });
});
