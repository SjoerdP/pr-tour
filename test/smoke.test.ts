import { describe, expect, it } from 'vitest';

// Proves the `node` vitest project is wired: tests here run under Node,
// without a DOM. Delete once real tests exist.
describe('node test project', () => {
  it('runs without a DOM', () => {
    expect('document' in globalThis).toBe(false);
  });
});
