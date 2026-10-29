import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyCheck, checkInput, coverage } from '../../src/server/analysis/merge.js';
import type { CheckOutput } from '../../src/server/analysis/contract.js';
import { TourSchema, type Tour, type TourBodyInput } from '../../src/shared/tour.js';

function tour(): Tour {
  const body = JSON.parse(
    readFileSync(new URL('../fixtures/tour-body.json', import.meta.url), 'utf8'),
  ) as TourBodyInput;
  body.foundations.forEach((f, i) => (f.id = `f${i}`));
  body.other.forEach((g, i) => g.items.forEach((it, j) => (it.id = `o${i}.${j}`)));
  const flow = body.flows[0]!;
  flow.id = 'F1';
  flow.steps[0]!.id = 'F1.S1';
  flow.steps[1]!.id = 'F1.S2';
  flow.steps[0]!.sideEffects[0]!.line = 22;
  // Make both steps Go function steps.
  flow.steps[0]!.file = 'src/loans/repay.go';
  flow.steps[1]!.file = 'src/loans/balance.go';
  return TourSchema.parse({
    ...body,
    repo: 'a/b',
    pr: 1,
    baseSha: 'a',
    headSha: 'b',
    source: 'inferred',
    createdAt: 'x',
    check: { problems: [] },
    hashes: {},
  });
}

function output(): CheckOutput {
  return {
    version: 1,
    engine: 'go-types',
    engineVersion: 'v1',
    degraded: false,
    steps: {
      'F1.S1': {
        anchor: { name: 'repayLoan', startLine: 10, endLine: 41, source: 'symbol' },
        marks: [{ line: 22, kind: 'db-write', source: 'both' }],
        callSites: [
          { line: 18, col: 3, endCol: 20, to: { file: 'b.go', line: 5 }, toStep: 'F1.S2' },
        ],
      },
      'F1.S2': { marks: [], callSites: [] },
    },
    links: {
      F1: [
        { from: 'F1.S1', to: 'F1.S2', line: 18, how: 'call', source: 'both', check: 'proven' },
        {
          from: 'F1.S1',
          to: 'F1.S2',
          line: 30,
          how: 'service',
          source: 'claude',
          check: 'unchecked',
        },
      ],
    },
    problems: ['a problem'],
  };
}

describe('checkInput', () => {
  it('maps steps with from and side-effect lines', () => {
    const input = checkInput(tour());
    expect(input.flows).toHaveLength(1);
    const [s1, s2] = input.flows[0]!.steps;
    expect(s1).toMatchObject({
      id: 'F1.S1',
      file: 'src/loans/repay.go',
      symbol: 'repayLoan',
      startLine: 10,
      endLine: 41,
    });
    expect(s1!.from).toBeUndefined();
    expect(s1!.sideEffects[0]).toEqual({ kind: 'db-write', label: 'INSERT repayments', line: 22 });
    expect(s1!.sideEffects[1]).toEqual({ kind: 'event', label: 'loan.repaid' });
    expect(s2!.from).toEqual({ step: 1, line: 18, how: 'call' });
  });
});

describe('applyCheck', () => {
  it('copies results by id and sets analysis', () => {
    const out = applyCheck(tour(), { ok: true, output: output(), ms: 42 });
    const [s1, s2] = out.flows[0]!.steps;
    expect(s1!.anchor?.name).toBe('repayLoan');
    expect(s1!.marks).toHaveLength(1);
    expect(s1!.callSites).toHaveLength(1);
    expect(s2!.anchor).toBeUndefined();
    expect(out.flows[0]!.links).toHaveLength(2);
    expect(out.analysis).toMatchObject({
      engine: 'go-types',
      engineVersion: 'v1',
      ms: 42,
      degraded: false,
      problems: ['a problem'],
      coverage: { functionSteps: 2, anchored: 1, links: 1, proven: 1, foundByCode: 0 },
    });
    expect(() => TourSchema.parse(out)).not.toThrow();
  });

  it('ignores unknown step ids and lists them in problems', () => {
    const o = output();
    o.steps['nope'] = { marks: [], callSites: [] };
    const out = applyCheck(tour(), { ok: true, output: o, ms: 1 });
    expect(out.analysis!.problems).toContain('a problem');
    expect(out.analysis!.problems.some((p) => p.includes('nope'))).toBe(true);
    expect(JSON.stringify(out)).not.toContain('"nope"');
  });

  it('gives engine none when there is no engine', () => {
    const out = applyCheck(tour(), null, 'no Go files in this PR');
    expect(out.analysis).toMatchObject({ engine: 'none', ms: 0, degraded: false });
    expect(out.analysis!.problems).toEqual(['no Go files in this PR']);
    expect(out.flows[0]!.steps[0]!.anchor).toBeUndefined();
  });

  it('records a failed run as engine none with its problem', () => {
    const out = applyCheck(tour(), { ok: false, problem: 'timed out', ms: 9 });
    expect(out.analysis).toMatchObject({ engine: 'none', ms: 9 });
    expect(out.analysis!.problems).toEqual(['timed out']);
  });

  it('keeps the pass C review on success and on failure', () => {
    const review = { ran: true, ms: 7, changes: [{ step: 'F1.S2', what: 'w', reason: 'r' }] };
    const t = { ...tour(), analysis: { ...applyCheck(tour(), null).analysis!, review } };
    expect(applyCheck(t, { ok: true, output: output(), ms: 1 }).analysis!.review).toEqual(review);
    expect(applyCheck(t, { ok: false, problem: 'timed out', ms: 9 }).analysis!.review).toEqual(
      review,
    );
    expect(applyCheck(t, null, 'no Go files in this PR').analysis!.review).toEqual(review);
  });

  it('keeps Claude’s explained how and reason on a link the code still cannot prove', () => {
    const o = output();
    o.links['F1'] = [
      { from: 'F1.S1', to: 'F1.S2', line: 18, how: 'call', source: 'claude', check: 'not-found' },
    ];
    const t = tour();
    t.flows[0]!.links = [
      {
        from: 'F1.S1',
        to: 'F1.S2',
        line: 18,
        how: 'register',
        source: 'claude',
        check: 'unchecked',
        reason: 'registered through dependency injection',
      },
    ];
    const out = applyCheck(t, { ok: true, output: o, ms: 1 });
    expect(out.flows[0]!.links).toEqual([
      {
        from: 'F1.S1',
        to: 'F1.S2',
        line: 18,
        how: 'register',
        source: 'claude',
        check: 'unchecked',
        reason: 'registered through dependency injection',
      },
    ]);
    expect(out.analysis!.coverage.proven).toBe(0);
    // A link the code now proves keeps the code's result, without Claude's reason.
    const proven = applyCheck(t, { ok: true, output: output(), ms: 1 });
    expect(proven.flows[0]!.links![0]).toEqual(output().links['F1']![0]);
  });

  it('is idempotent', () => {
    const r = { ok: true as const, output: output(), ms: 1 };
    const once = applyCheck(tour(), r);
    expect(applyCheck(once, r)).toEqual(once);
  });
});

describe('coverage', () => {
  it('counts only go function steps and call/register links', () => {
    const t = applyCheck(tour(), { ok: true, output: output(), ms: 1 });
    // A non-Go step does not count.
    t.flows[0]!.steps[1]!.file = 'src/x.ts';
    t.flows[0]!.steps[1]!.anchor = undefined;
    t.flows[0]!.links!.push({
      from: 'F1.S1',
      to: 'F1.S2',
      line: 19,
      how: 'call',
      source: 'code',
      check: 'proven',
    });
    expect(coverage(t)).toEqual({
      functionSteps: 1,
      anchored: 1,
      links: 2,
      proven: 2,
      foundByCode: 1,
    });
  });

  it('counts a Go step with a symbol and no anchor as a function step', () => {
    expect(coverage(tour()).functionSteps).toBe(2);
    expect(coverage(tour()).anchored).toBe(0);
  });
});
