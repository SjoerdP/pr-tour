import { describe, expect, it } from 'vitest';
import css from '../../src/web/styles.css?raw';

// jsdom does no layout, so these check the stylesheet's contract for the tour screen:
// the notes above the code keep their height and the code area is the part that gives way.

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`No rule for ${selector}`);
  return Object.fromEntries(
    match[1]!
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((d) => d.split(':').map((part) => part.trim()))
      .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== ''),
  );
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
