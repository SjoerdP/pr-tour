import { describe, expect, it } from 'vitest';
import { findings, findingText } from '../../src/server/analysis/findings.js';
import {
  applyReview,
  ReviewAnswerSchema,
  reviewChangeText,
  reviewPrompt,
  type ReviewChange,
} from '../../src/server/analysis/review.js';
import { TourSchema, type Step, type Tour } from '../../src/shared/tour.js';

function step(id: string, over: Partial<Step>): Step {
  return {
    id,
    title: id,
    file: 'x/a.go',
    startLine: 1,
    endLine: 5,
    changed: true,
    why: 'why',
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes: [],
    ...over,
  };
}

/**
 * Flow F1 with four steps and one finding of every kind; flow F2 with no finding.
 * Links: S1 -> S2 proven through a wrapper, S2 -> S3 Claude's but not found in the code,
 * S1 -> S3 found only by the code, S2 -> S4 proven.
 */
function fixture(): Tour {
  return TourSchema.parse({
    summary: 's',
    foundations: [],
    other: [],
    repo: 'a/b',
    pr: 1,
    baseSha: 'a',
    headSha: 'b',
    source: 'inferred',
    createdAt: 'x',
    check: { problems: [] },
    hashes: {},
    analysis: {
      engine: 'go-types',
      ms: 1,
      degraded: false,
      coverage: { functionSteps: 4, anchored: 4, links: 4, proven: 3, foundByCode: 1 },
      problems: [],
    },
    flows: [
      {
        id: 'F1',
        title: 'Repay a loan',
        entry: { kind: 'http', label: 'POST /repay' },
        steps: [
          step('F1.S1', {
            title: 'Handle repay',
            symbol: 'Handle',
            file: 'x/handler.go',
            anchor: { name: 'Handle', startLine: 10, endLine: 30, source: 'symbol' },
            marks: [{ line: 20, kind: 'db-write', label: 'INSERT', source: 'claude' }],
          }),
          step('F1.S2', {
            title: 'Record payment',
            symbol: 'Record',
            file: 'x/pay.go',
            from: { step: 1, line: 14, how: 'call' },
            anchor: { name: 'Pay', startLine: 5, endLine: 15, source: 'range' },
          }),
          step('F1.S3', {
            title: 'Send event',
            symbol: 'Publish',
            file: 'x/events.go',
            from: { step: 1, line: 25, how: 'call' },
            anchor: { name: 'Publish', startLine: 3, endLine: 9, source: 'symbol' },
          }),
          step('F1.S4', {
            title: 'Log it',
            symbol: 'Log',
            file: 'x/log.go',
            from: { step: 2, line: 12, how: 'call' },
            anchor: { name: 'Log', startLine: 1, endLine: 4, source: 'symbol' },
          }),
        ],
        links: [
          {
            from: 'F1.S1',
            to: 'F1.S2',
            line: 14,
            how: 'call',
            via: ['wrap'],
            source: 'both',
            check: 'proven',
          },
          {
            from: 'F1.S2',
            to: 'F1.S3',
            line: 8,
            how: 'call',
            source: 'claude',
            check: 'not-found',
          },
          { from: 'F1.S1', to: 'F1.S3', line: 25, how: 'call', source: 'code', check: 'proven' },
          { from: 'F1.S2', to: 'F1.S4', line: 12, how: 'call', source: 'both', check: 'proven' },
        ],
      },
      {
        id: 'F2',
        title: 'Other',
        entry: { kind: 'job', label: 'cron' },
        steps: [
          step('F2.S1', {
            symbol: 'Run',
            anchor: { name: 'Run', startLine: 1, endLine: 5, source: 'symbol' },
          }),
        ],
        links: [],
      },
    ],
  });
}

const symbol: ReviewChange = {
  kind: 'symbol',
  step: 'F1.S2',
  symbol: 'Pay',
  reason: 'the payment is written in Pay',
};

describe('findings', () => {
  it('lists each kind of finding from a checked tour', () => {
    const list = findings(fixture());
    expect(list.map((f) => f.kind)).toEqual([
      'mark-no-call',
      'symbol-missing',
      'via',
      'not-found',
      'code-only',
    ]);
    expect(list[0]).toEqual({ kind: 'mark-no-call', step: 'F1.S1', line: 20 });
    expect(list[1]).toEqual({ kind: 'symbol-missing', step: 'F1.S2', symbol: 'Record' });
    expect(list[3]).toMatchObject({ kind: 'not-found', flow: 'F1', link: { to: 'F1.S3' } });
  });

  it('has none when no checker ran', () => {
    const t = fixture();
    t.analysis!.engine = 'none';
    expect(findings(t)).toEqual([]);
    delete t.analysis;
    expect(findings(t)).toEqual([]);
  });

  it('describes each finding in one plain line', () => {
    const t = fixture();
    const texts = findings(t).map((f) => findingText(t, f));
    expect(texts).toEqual([
      'step 1 "Handle repay" (F1.S1): the db-write line 20 holds no call',
      'step 2 "Record payment" (F1.S2): the code has no function Record in x/pay.go; the step was pinned to Pay instead',
      'step 1 "Handle repay" (F1.S1) reaches step 2 "Record payment" (F1.S2) only through wrap',
      'step 2 "Record payment" (F1.S2) calls step 3 "Send event" (F1.S3) at line 8, says the tour, but the code does not show it',
      'the code shows step 1 "Handle repay" (F1.S1) reaching step 3 "Send event" (F1.S3) at line 25, but the tour does not say so',
    ]);
  });
});

describe('ReviewAnswerSchema', () => {
  it('reads a list of changes and rejects other kinds', () => {
    const changes = [{ kind: 'why', step: 'F1.S1', why: 'w', reason: 'r' }];
    expect(ReviewAnswerSchema.parse({ changes })).toEqual({ changes });
    expect(
      ReviewAnswerSchema.safeParse({ changes: [{ kind: 'homes', reason: 'r' }] }).success,
    ).toBe(false);
    expect(ReviewAnswerSchema.safeParse({}).success).toBe(false);
  });
});

describe('reviewPrompt', () => {
  it('lists the findings, the steps, the code, the rules and the answer shape', () => {
    const t = fixture();
    const list = findings(t);
    const prompt = reviewPrompt(t, list, { 'F1.S2': 'func Pay() {\n\tcreate()\n}' });
    for (const f of list) expect(prompt).toContain(findingText(t, f));
    expect(prompt).toContain('func Pay() {');
    expect(prompt).toContain('F1.S2');
    expect(prompt).toContain('Record payment');
    expect(prompt).toMatch(/may change/i);
    expect(prompt).toMatch(/may not change/i);
    expect(prompt).toContain('"changes"');
    expect(prompt).not.toContain('F2.S1');
  });
});

describe('applyReview', () => {
  it('applies a symbol change', () => {
    const before = fixture();
    const { tour, applied, dropped } = applyReview(before, [symbol]);
    expect(tour.flows[0]!.steps[1]!.symbol).toBe('Pay');
    expect(applied).toEqual([symbol]);
    expect(dropped).toEqual([]);
    expect(before.flows[0]!.steps[1]!.symbol).toBe('Record');
  });

  it('applies a why change on a step in a finding', () => {
    const change: ReviewChange = { kind: 'why', step: 'F1.S3', why: 'New why.', reason: 'r' };
    const { tour, applied } = applyReview(fixture(), [change]);
    expect(tour.flows[0]!.steps[2]!.why).toBe('New why.');
    expect(applied).toEqual([change]);
  });

  it('drops a change for a step without a finding', () => {
    const change: ReviewChange = { kind: 'symbol', step: 'F2.S1', symbol: 'Go', reason: 'r' };
    const { tour, applied, dropped } = applyReview(fixture(), [change]);
    expect(tour.flows[1]!.steps[0]!.symbol).toBe('Run');
    expect(applied).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.change).toEqual(change);
    expect(dropped[0]!.why).toContain('F2.S1');
  });

  it('drops a change to the order of a flow without a finding', () => {
    const change: ReviewChange = { kind: 'order', flow: 'F2', steps: ['F2.S1'], reason: 'r' };
    expect(applyReview(fixture(), [change]).dropped).toHaveLength(1);
  });

  it('applies a link-how change on an unproven link, with its reason', () => {
    const change: ReviewChange = {
      kind: 'link-how',
      flow: 'F1',
      from: 'F1.S2',
      to: 'F1.S3',
      how: 'event',
      reason: 'Publish runs from the loan.repaid event',
    };
    const { tour, applied } = applyReview(fixture(), [change]);
    expect(applied).toEqual([change]);
    const link = tour.flows[0]!.links!.find((l) => l.from === 'F1.S2' && l.to === 'F1.S3');
    expect(link).toMatchObject({ how: 'event', check: 'unchecked', reason: change.reason });
    // S3's own story is Claude's: it came from step 1; only a `from` on S2 would change.
    expect(tour.flows[0]!.steps[2]!.from?.how).toBe('call');
  });

  it('sets the calling step’s from.how when the link is the step’s from', () => {
    const t = fixture();
    t.flows[0]!.steps[2]!.from = { step: 2, line: 8, how: 'call' };
    const change: ReviewChange = {
      kind: 'link-how',
      flow: 'F1',
      from: 'F1.S2',
      to: 'F1.S3',
      how: 'service',
      reason: 'HTTP call to the events service',
    };
    const { tour } = applyReview(t, [change]);
    expect(tour.flows[0]!.steps[2]!.from?.how).toBe('service');
  });

  it('drops a link-how change on a proven link', () => {
    const change: ReviewChange = {
      kind: 'link-how',
      flow: 'F1',
      from: 'F1.S1',
      to: 'F1.S2',
      how: 'service',
      reason: 'r',
    };
    const { tour, applied, dropped } = applyReview(fixture(), [change]);
    expect(applied).toEqual([]);
    expect(dropped[0]!.why).toMatch(/proven/);
    expect(tour.flows[0]!.links![0]!.how).toBe('call');
  });

  it('drops a link-how change on a link that is not in a finding', () => {
    const t = fixture();
    t.flows[0]!.links![3]!.check = 'name-match';
    const change: ReviewChange = {
      kind: 'link-how',
      flow: 'F1',
      from: 'F1.S2',
      to: 'F1.S4',
      how: 'service',
      reason: 'r',
    };
    expect(applyReview(t, [change]).dropped).toHaveLength(1);
  });

  it('drops an order that is not a permutation of the flow’s steps', () => {
    for (const steps of [
      ['F1.S1', 'F1.S2', 'F1.S3'],
      ['F1.S1', 'F1.S2', 'F1.S3', 'F1.S3'],
      ['F1.S1', 'F1.S2', 'F1.S3', 'F2.S1'],
    ]) {
      const change: ReviewChange = { kind: 'order', flow: 'F1', steps, reason: 'r' };
      const { tour, applied, dropped } = applyReview(fixture(), [change]);
      expect(applied).toEqual([]);
      expect(dropped).toHaveLength(1);
      expect(tour.flows[0]!.steps.map((s) => s.id)).toEqual(['F1.S1', 'F1.S2', 'F1.S3', 'F1.S4']);
    }
  });

  it('reorders steps and renumbers from.step to the same calling step', () => {
    const change: ReviewChange = {
      kind: 'order',
      flow: 'F1',
      steps: ['F1.S1', 'F1.S3', 'F1.S2', 'F1.S4'],
      reason: 'the event goes out before the payment is recorded',
    };
    const { tour, applied } = applyReview(fixture(), [change]);
    expect(applied).toEqual([change]);
    const steps = tour.flows[0]!.steps;
    expect(steps.map((s) => s.id)).toEqual(['F1.S1', 'F1.S3', 'F1.S2', 'F1.S4']);
    expect(steps.map((s) => s.from?.step)).toEqual([undefined, 1, 1, 3]);
    expect(() => TourSchema.parse(tour)).not.toThrow();
  });

  it('drops an order that puts a calling step after the step it calls', () => {
    for (const steps of [
      ['F1.S1', 'F1.S4', 'F1.S2', 'F1.S3'],
      ['F1.S2', 'F1.S1', 'F1.S3', 'F1.S4'],
    ]) {
      const change: ReviewChange = { kind: 'order', flow: 'F1', steps, reason: 'r' };
      const { applied, dropped } = applyReview(fixture(), [change]);
      expect(applied).toEqual([]);
      expect(dropped).toHaveLength(1);
    }
  });

  it('keeps applied and dropped changes apart', () => {
    const bad: ReviewChange = { kind: 'why', step: 'F2.S1', why: 'x', reason: 'r' };
    const { applied, dropped } = applyReview(fixture(), [symbol, bad]);
    expect(applied).toEqual([symbol]);
    expect(dropped.map((d) => d.change)).toEqual([bad]);
  });
});

describe('reviewChangeText', () => {
  it('says what changed in one short sentence', () => {
    const before = fixture();
    const order: ReviewChange = {
      kind: 'order',
      flow: 'F1',
      steps: ['F1.S1', 'F1.S3', 'F1.S2', 'F1.S4'],
      reason: 'r',
    };
    const link: ReviewChange = {
      kind: 'link-how',
      flow: 'F1',
      from: 'F1.S2',
      to: 'F1.S3',
      how: 'service',
      reason: 'r',
    };
    const why: ReviewChange = { kind: 'why', step: 'F1.S3', why: 'w', reason: 'r' };
    const { tour: after } = applyReview(before, [symbol, order, link, why]);
    expect(reviewChangeText(before, after, symbol)).toEqual({
      step: 'F1.S2',
      what: 'Step 3 in "Repay a loan" now points at Pay, not Record',
      reason: symbol.reason,
    });
    expect(reviewChangeText(before, after, order)).toEqual({
      what: 'The steps of "Repay a loan" now run in the order 1, 3, 2, 4',
      reason: 'r',
    });
    expect(reviewChangeText(before, after, link)).toEqual({
      step: 'F1.S3',
      what: 'Step 2 in "Repay a loan" is now reached from step 3 by a call to another service',
      reason: 'r',
    });
    expect(reviewChangeText(before, after, why)).toEqual({
      step: 'F1.S3',
      what: 'Step 2 in "Repay a loan" has a new why note',
      reason: 'r',
    });
  });
});
