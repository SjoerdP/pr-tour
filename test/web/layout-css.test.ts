import { describe, expect, it } from 'vitest';
import { REVIEW_COLUMN_QUERY } from '../../src/web/review-column.js';
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
    // The stylesheet and the code that asks for column mode use the same query.
    const wide = REVIEW_COLUMN_QUERY;
    expect(wide).toBe('(min-width: 1300px)');
    expect(rule('.review-panel-box').width).toBe('min(var(--review-width), 100vw)');
    // At 1300px: 26vw = 338px, so the main area keeps 1300 - 320 - 338 = 642px.
    expect(rule(':root')['--review-width']).toBe('clamp(320px, 26vw, 400px)');
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
    expect(() => mediaRule('(max-width: 1299px)', '.review-open .tour-body')).toThrow();
    // No other query gives the panel a column (one breakpoint, in one place).
    expect(css.match(/\.review-open \.tour-body/g)).toHaveLength(1);
    const box = rule('.review-panel-box');
    expect(box.position).toBe('absolute');
    expect(box['box-shadow']).toBe('var(--shadow-popover)');
  });

  it('a drag over line numbers selects no text in the code', () => {
    expect(rule('.code-dragging')['user-select']).toBe('none');
  });

  it('step facts are chips, and warnings are tinted chips', () => {
    expect(rule('.step-facts li')['border-radius']).toBe('999px');
    expect(css).not.toMatch(/\.step-facts li \+ li::before/);
    const warn = rule('.step-facts .fact-risk,\n.step-facts .fact-warn');
    expect(warn.background).toBe('var(--warn-bg)');
    expect(warn['border-color']).toBe('var(--warn-border)');
  });

  it('the why is a panel with a section-head label', () => {
    expect(rule('.why').background).toBe('var(--bg-subtle)');
    expect(rule('.why-label')['text-transform']).toBe('uppercase');
    expect(rule('.why-label').color).toBe('var(--fg-muted)');
  });

  it('the comment button is a visible accent +, and the row it would comment on is outlined', () => {
    const plus = rule('.code-no-button::before');
    expect(plus.content).toBe("'+'");
    expect(plus.background).toBe('var(--accent)');
    expect(plus.color).toBe('var(--accent-fg)');
    expect(css).toMatch(/\.code-row:hover \.code-no-button::before/);
    expect(rule('.code-row:has(.code-no-button:hover)')['box-shadow']).toContain('var(--accent)');
  });

  it('a mark only the tour claims keeps full muted colour and has a dashed border', () => {
    const claude = rule('.mark-claude');
    expect(claude.opacity).toBeUndefined();
    expect(claude['border-style']).toBe('dashed');
  });

  it('the flow map scrolls inside itself', () => {
    expect(rule('.flow-map')['overflow']).toBe('auto');
  });

  it('the flow map fills the panel below its head and scrolls there, not the panel', () => {
    const panel = rule('.flow-map-panel');
    expect(panel.display).toBe('flex');
    expect(panel['flex-direction']).toBe('column');
    expect(panel.overflow).toBeUndefined();
    expect(rule('.flow-map').flex).toBe('1 1 auto');
    expect(rule('.flow-map')['min-height']).toBe('0');
  });

  it('the calls of a step hang off one line: a trunk, a bar across them, a drop each', () => {
    // Each step is centred over its calls.
    expect(rule('.flow-map-branch')['align-items']).toBe('center');
    // (`rule('.flow-map-row')` would find the list reset shared with `.flow-map-tree` first.)
    expect(css).toMatch(/\n\.flow-map-row \{[^}]*justify-content: center;/);
    // The trunk runs down from the middle of the step's box.
    const trunk = rule('.flow-map-branch > .flow-map-row::before');
    expect(trunk.left).toBe('50%');
    expect(trunk['border-left']).toBe('2px solid var(--fg-muted)');
    // Each call draws its half of the bar; the right half also drops to the call's middle and
    // reaches the call's right edge, so the bar has no gaps.
    const halves =
      '.flow-map-branch > .flow-map-row > .flow-map-branch::before,\n' +
      '.flow-map-branch > .flow-map-row > .flow-map-branch::after';
    expect(rule(halves)['border-top']).toBe('2px solid var(--fg-muted)');
    // (`rule()` would find the shared list above first, so match the rule's own body.)
    expect(css).toMatch(
      /\n\.flow-map-branch > \.flow-map-row > \.flow-map-branch::after \{\n {2}left: calc\(50% - 1px\);\n {2}width: calc\(50% \+ 1px\);\n {2}border-left: 2px solid var\(--fg-muted\);/,
    );
    // Into each box: a stem that ends in an arrowhead.
    expect(rule('.flow-map-stem')['border-left']).toBe('2px solid var(--fg-muted)');
    expect(rule('.flow-map-stem::after')['border-top']).toBe('6px solid var(--fg-muted)');
  });

  it('a long arrow label wraps at the card width', () => {
    const label = rule('.flow-map-edge,\n.flow-map-entry');
    expect(label['max-width']).toBe('240px');
    expect(label['white-space']).toBe('normal');
    expect(rule('.flow-map-card').width).toBe('240px');
  });

  it('the overview step strip is a grid of equal chips', () => {
    expect(rule('.overview-strip').display).toBe('grid');
    expect(rule('.overview-strip')['grid-template-columns']).toBe(
      'repeat(auto-fill, minmax(200px, 1fr))',
    );
  });

  it('an overview strip chip fills its grid cell, so all chips are the same width', () => {
    expect(rule('.overview-strip > li').display).toBe('flex');
    expect(rule('.overview-step').width).toBe('100%');
  });

  it('the unlinked steps heading is styled by class, so its level can change', () => {
    expect(rule('.flow-map-unlinked-title')['font-size']).toBe('var(--font-size-small)');
    expect(css).not.toContain('.flow-map-unlinked h3');
  });

  it('the rest of the PR has no dots made by CSS: they would be read aloud', () => {
    expect(css).not.toMatch(/\.overview-rest-part[^{]*::before/);
  });

  it('colors and outline font sizes come from tokens', () => {
    const body = css.slice(css.indexOf('*,'));
    expect(body).not.toMatch(/font-size:\s*\d+px/);
    expect(body).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
