import { describe, expect, it } from 'vitest';
import type { Flow, Step } from '../../src/shared/tour.js';
import { callEnd, stepTargets } from '../../src/web/step-badges.js';

describe('callEnd', () => {
  const end = (text: string, name: string) => callEnd(text, text.indexOf(name) + name.length);

  it('ends after the argument list', () => {
    expect('  f(a, g(b)); x'.slice(0, end('  f(a, g(b)); x', 'f'))).toBe('  f(a, g(b))');
  });

  it('skips brackets inside strings', () => {
    const text = 'f("(", `)`, \'(\') + 1';
    expect(text.slice(0, end(text, 'f'))).toBe('f("(", `)`, \'(\')');
  });

  it('takes Go type arguments before the call', () => {
    const text = 'x := Map[int, string](m) // done';
    expect(text.slice(0, end(text, 'Map'))).toBe('x := Map[int, string](m)');
  });

  it('a name without arguments ends at the name', () => {
    expect(end('register(handler, next)', 'handler')).toBe('register(handler'.length);
  });

  it('an argument list not closed on the line ends at the end of the code', () => {
    expect(end('  call(a,   ', 'call')).toBe('  call(a,'.length);
  });
});

describe('stepTargets', () => {
  function step(id: string, extra: Partial<Step> = {}): Step {
    return {
      id,
      title: id,
      file: 'a.go',
      startLine: 1,
      endLine: 9,
      changed: true,
      why: '',
      risk: 'skim',
      sideEffects: [],
      tests: [],
      calls: [],
      homes: [],
      ...extra,
    };
  }

  it('merges links and call sites, keeps helpers, and marks the next step', () => {
    const s1 = step('S1', {
      callSites: [
        { line: 4, col: 1, endCol: 2, to: { file: 'a.go', line: 20 }, toStep: 'S3' },
        { line: 3, col: 1, endCol: 2, to: { file: 'a.go', line: 30 }, toStep: 'S2' },
      ],
    });
    const flow: Flow = {
      id: 'F',
      title: 'F',
      entry: { kind: 'http', label: 'GET /' },
      steps: [s1, step('S2'), step('S3')],
      links: [
        { from: 'S1', to: 'S2', line: 3, how: 'call', via: ['h'], source: 'both', check: 'proven' },
        { from: 'S1', to: 'S3', line: 8, how: 'call', source: 'claude', check: 'not-found' },
        { from: 'S2', to: 'S3', line: 5, how: 'call', source: 'code', check: 'proven' },
      ],
    };
    const targets = stepTargets(flow, s1).map((t) => [t.line, t.no, t.next, t.via]);
    expect(targets).toEqual([
      [3, 2, true, ['h']],
      [4, 3, false, []],
    ]);
  });
});
