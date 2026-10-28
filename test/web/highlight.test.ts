import { describe, expect, it } from 'vitest';
import { highlight } from '../../src/web/highlight.js';

describe('highlight', () => {
  it('colours a known language, one entry per line', async () => {
    const lines = await highlight('const a = 1;\nfoo();\n', 'src/a.ts', 'light');
    expect(lines.map((l) => l.map((t) => t.content).join(''))).toEqual([
      'const a = 1;',
      'foo();',
      '',
    ]);
    expect(lines[0]!.find((t) => t.content === 'const')?.color).toMatch(/^#/);
  });

  it('finds the language by an alias extension', async () => {
    const lines = await highlight('key: value\n', '.github/ci.yml', 'dark');
    expect(lines[0]!.some((t) => t.color !== undefined)).toBe(true);
  });

  it('unknown extension gives plain text', async () => {
    expect(await highlight('just words\n', 'notes.unknownext', 'light')).toEqual([
      [{ content: 'just words' }],
      [{ content: '' }],
    ]);
  });
});
