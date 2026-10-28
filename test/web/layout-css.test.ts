import { describe, expect, it } from 'vitest';
import css from '../../src/web/styles.css?raw';

// jsdom does no layout, so these check the stylesheet's contract for the tour screen:
// the notes above the code keep their height and the code area is the part that gives way.

/** `prop: value;` pairs of a rule body, comments left out. */
function declarations(body: string): Record<string, string> {
  return Object.fromEntries(
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((d) => d.split(':').map((part) => part.trim()))
      .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== ''),
  );
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`No rule for ${selector}`);
  return declarations(match[1]!);
}

/** The declarations of `selector` (alone or in a selector list) inside `@media <query>`. */
function mediaRule(query: string, selector: string): Record<string, string> {
  const start = css.indexOf(`@media ${query} {`);
  if (start < 0) throw new Error(`No @media ${query}`);
  // The block ends at the first line that is a lone closing brace.
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  for (const [, selectors, body] of block.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const list = selectors!.replace(/\/\*[\s\S]*?\*\//g, '').split(',');
    if (list.some((s) => s.trim() === selector)) return declarations(body!);
  }
  throw new Error(`No rule for ${selector} in @media ${query}`);
}

describe('tour layout CSS', () => {
  it('the notes never shrink below their content; they scroll only past a cap', () => {
    const notes = rule('.step-notes');
    expect(notes.flex).toBe('none');
    expect(notes['max-height']).toBeDefined();
    expect(notes['overflow-y']).toBe('auto');
  });

  it('the code view takes the rest of the height and shrinks instead of the notes', () => {
    const code = rule('.code-view');
    expect(code.flex).toBe('1 1 0');
    expect(rule('.code')['overflow']).toBe('auto');
  });

  it('the tour screen has no max-width; the outline is a fixed column on the left', () => {
    expect(rule('.tour-app')['max-width']).toBeUndefined();
    expect(rule('.tour-body')['grid-template-columns']).toBe('var(--outline-width) minmax(0, 1fr)');
  });

  it('on a wide window the open review panel is a column: the main area makes room', () => {
    const wide = '(min-width: 1100px)';
    expect(rule('.review-panel-box').width).toBe('min(var(--review-width), 100vw)');
    // The notices and the outline | main grid stop short of the panel.
    const body = mediaRule(wide, '.review-open .tour-body');
    expect(body['margin-right']).toBe('var(--review-width)');
    expect(mediaRule(wide, '.review-open .notices')['margin-right']).toBe('var(--review-width)');
    // A column, not a popover: no shadow over the code.
    expect(mediaRule(wide, '.review-open .review-panel-box')['box-shadow']).toBe('none');
    // The outline keeps its width; the code still scrolls sideways inside its own box.
    expect(rule('.tour-body')['grid-template-columns']).toBe('var(--outline-width) minmax(0, 1fr)');
    expect(rule('.code')['overflow']).toBe('auto');
  });

  it('on a narrow window the review panel stays an overlay', () => {
    expect(() => mediaRule('(max-width: 1099px)', '.review-open .tour-body')).toThrow();
    const box = rule('.review-panel-box');
    expect(box.position).toBe('absolute');
    expect(box['box-shadow']).toBe('var(--shadow-popover)');
  });

  it('a drag over line numbers selects no text in the code', () => {
    expect(rule('.code-dragging')['user-select']).toBe('none');
  });

  it('step facts have the same space on both sides of the separator', () => {
    const gap = rule('.step-facts li').gap;
    expect(gap).toBeDefined();
    expect(rule('.step-facts')['column-gap']).toBe(gap);
    expect(rule('.step-facts li + li::before')['padding-right']).toBeUndefined();
  });

  it('colors and outline font sizes come from tokens', () => {
    const body = css.slice(css.indexOf('*,'));
    expect(body).not.toMatch(/font-size:\s*\d+px/);
    expect(body).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
