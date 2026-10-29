import { beforeAll, describe, expect, it } from 'vitest';
import { highlight } from '../../src/web/highlight.js';

describe('highlight', () => {
  // Shiki and each grammar load on first use. That load is slow when the whole suite runs at
  // once and can pass the 5 s test default, so do it once here, with room to finish.
  beforeAll(async () => {
    await highlight('const a = 1;', 'src/a.ts', 'light');
    await highlight('a: 1', 'a.yml', 'dark');
  }, 60_000);

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

  it('a file over 100,000 characters is shown plain', async () => {
    const text = 'const a = 1;\n'.repeat(8000);
    const lines = await highlight(text, 'src/big.ts', 'light');
    expect(lines).toHaveLength(8001);
    expect(lines.every((l) => l.every((t) => t.color === undefined))).toBe(true);
  });
});
