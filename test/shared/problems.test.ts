import { describe, expect, it } from 'vitest';
import {
  botLevel,
  botName,
  botTitle,
  isBotLogin,
  mergeProblems,
  placeProblems,
  sortProblems,
  type PlacedProblem,
  type Problem,
} from '../../src/shared/problems.js';
import type { Step, Tour } from '../../src/shared/tour.js';

// A small acme/loans tour: a foundation, a repay flow with steps in their own files and
// line ranges (one lists a test), and other items, one of which covers a whole file.
function step(id: string, file: string, start: number, end: number, changed = true): Step {
  return {
    id,
    title: id,
    file,
    startLine: start,
    endLine: end,
    changed,
    why: `Why ${id}.`,
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes: changed ? [{ file, side: 'new', start: start + 1, end: end - 1 }] : [],
  };
}

const tour: Tour = {
  repo: 'acme/loans',
  pr: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  source: 'author',
  createdAt: '2026-10-27T12:00:00Z',
  summary: 'Adds early repayment.',
  foundations: [
    {
      id: 'f1',
      kind: 'migration',
      title: 'Create repayments table',
      file: 'm.sql',
      why: 'Stores repayments.',
      risk: 'skim',
      homes: [{ file: 'm.sql', side: 'new', start: 1, end: 3 }],
    },
  ],
  flows: [
    {
      id: 'F1',
      title: 'Repay a loan',
      entry: { kind: 'http', label: 'POST /repay' },
      steps: [
        step('F1.S1', 'loans/handler.go', 10, 30),
        step('F1.S2', 'loans/store.go', 5, 20, false),
        {
          ...step('F1.S3', 'loans/repay.go', 40, 60),
          tests: [{ file: 'loans/repay_test.go', name: 'TestRepayChargesFee' }],
        },
        step('F1.S4', 'loans/handler.go', 31, 40, false),
      ],
    },
  ],
  other: [
    {
      kind: 'tests',
      title: 'Tests',
      summary: 'Tests for repay.',
      items: [
        {
          id: 'o1.1',
          file: 'test/repay.test.ts',
          title: 'Repay tests',
          homes: [{ file: 'test/repay.test.ts', side: 'new', start: 1, end: 9 }],
        },
        {
          id: 'o1.2',
          file: 'gen/api.go',
          title: 'Generated API',
          homes: [{ file: 'gen/api.go', whole: true }],
        },
      ],
    },
  ],
  check: { problems: [] },
  hashes: {},
};

function line(key: string, file: string, n: number, extra: Partial<Problem> = {}): Problem {
  return {
    key,
    level: 'look',
    title: `Title ${key}`,
    sources: ['golangci-lint'],
    at: { kind: 'line', file, side: 'new', line: n },
    ...extra,
  };
}

function homeOf(problem: Problem): string | null {
  const [placed] = placeProblems(tour, [problem]);
  return placed ? placed.homeId : 'missing';
}

describe('placeProblems', () => {
  it('places a line problem on the step whose range holds it', () => {
    expect(homeOf(line('a', 'loans/repay.go', 45))).toBe('F1.S3');
    // An unchanged step's range counts too.
    expect(homeOf(line('b', 'loans/store.go', 7))).toBe('F1.S2');
  });

  it('places it on a foundation or other item by its homes', () => {
    expect(homeOf(line('a', 'm.sql', 2))).toBe('f1');
    expect(homeOf(line('b', 'test/repay.test.ts', 4))).toBe('o1.1');
  });

  it('leaves a line no home holds with homeId null', () => {
    // Outside every step and home range.
    expect(homeOf(line('a', 'loans/repay.go', 99))).toBeNull();
    // A whole-file home holds no line.
    expect(homeOf(line('b', 'gen/api.go', 3))).toBeNull();
    // An old-side line is not in a step's head range.
    const old = line('c', 'loans/repay.go', 45);
    old.at = { kind: 'line', file: 'loans/repay.go', side: 'old', line: 45 };
    expect(homeOf(old)).toBeNull();
  });

  it('places a failing test on the step that lists it', () => {
    const p: Problem = {
      key: 't',
      level: 'bug',
      title: 'Test fails',
      sources: ['CI tests'],
      at: { kind: 'step', test: 'TestRepayChargesFee' },
    };
    expect(homeOf(p)).toBe('F1.S3');
    expect(homeOf({ ...p, at: { kind: 'step', test: 'TestOther' } })).toBeNull();
  });

  it('places a file problem on the first home of that file', () => {
    const p: Problem = {
      key: 'f',
      level: 'risk',
      title: 'Build fails',
      sources: ['CI'],
      at: { kind: 'file', file: 'gen/api.go' },
    };
    expect(homeOf(p)).toBe('o1.2');
    expect(homeOf({ ...p, at: { kind: 'file', file: 'loans/handler.go' } })).toBe('F1.S1');
    expect(homeOf({ ...p, at: { kind: 'file', file: 'nowhere.go' } })).toBeNull();
  });

  it('keeps a PR-wide problem unplaced', () => {
    const p: Problem = {
      key: 'pr',
      level: 'bug',
      title: 'Lint fails',
      sources: ['CI'],
      at: { kind: 'pr' },
    };
    expect(placeProblems(tour, [p])).toEqual([{ ...p, homeId: null }]);
  });
});

describe('mergeProblems', () => {
  it('merges a CI annotation into a bot thread 2 lines away', () => {
    const thread = line('thread-1', 'loans/repay.go', 45, {
      level: 'look',
      title: 'Charge the fee before saving.',
      why: 'The fee is lost when saving fails.',
      sources: ['CodeRabbit'],
      url: 'https://github.com/acme/loans/pull/42#discussion_r1',
      threadId: 'PRRT_1',
    });
    const annotation = line('ci-1', 'loans/repay.go', 47, { level: 'bug' });
    const other = line('ci-2', 'loans/handler.go', 12);
    const merged = mergeProblems([annotation, thread, other]);
    expect(merged).toEqual([
      { ...thread, level: 'bug', sources: ['CodeRabbit', 'golangci-lint'] },
      other,
    ]);
  });

  it('does not merge two annotations on the same line', () => {
    const a = line('a', 'loans/repay.go', 45);
    const b = line('b', 'loans/repay.go', 45, { sources: ['staticcheck'] });
    expect(mergeProblems([a, b])).toEqual([a, b]);
  });

  it('does not merge 3 lines apart', () => {
    const thread = line('t', 'loans/repay.go', 45, { sources: ['CodeRabbit'], threadId: 'PRRT_1' });
    const a = line('a', 'loans/repay.go', 48);
    expect(mergeProblems([thread, a])).toEqual([thread, a]);
  });

  it('does not merge across files or sides', () => {
    const thread = line('t', 'loans/repay.go', 45, { sources: ['CodeRabbit'], threadId: 'PRRT_1' });
    const a = line('a', 'loans/handler.go', 45);
    const b: Problem = {
      ...line('b', 'loans/repay.go', 45),
      at: { kind: 'line', file: 'loans/repay.go', side: 'old', line: 45 },
    };
    expect(mergeProblems([thread, a, b])).toEqual([thread, a, b]);
  });
});

describe('sortProblems', () => {
  it('sorts by level, then PR-wide, then tour order, unplaced last', () => {
    const placed = (
      key: string,
      level: Problem['level'],
      homeId: string | null,
      n = 1,
    ): PlacedProblem => ({
      ...line(key, 'x.go', n, { level }),
      homeId,
    });
    const prWide: PlacedProblem = {
      key: 'pr',
      level: 'risk',
      title: 'Lint fails',
      sources: ['CI'],
      at: { kind: 'pr' },
      homeId: null,
    };
    const list = [
      placed('look-step', 'look', 'F1.S1'),
      placed('risk-null', 'risk', null),
      placed('risk-other', 'risk', 'o1.1'),
      placed('risk-step-late', 'risk', 'F1.S3', 50),
      placed('risk-step-early', 'risk', 'F1.S3', 42),
      prWide,
      placed('risk-found', 'risk', 'f1'),
      placed('bug-step', 'bug', 'F1.S1'),
    ];
    expect(sortProblems(tour, list).map((p) => p.key)).toEqual([
      'bug-step',
      'pr',
      'risk-found',
      'risk-step-early',
      'risk-step-late',
      'risk-other',
      'risk-null',
      'look-step',
    ]);
  });
});

describe('bot comments', () => {
  it('botLevel reads CodeRabbit potential issues as a risk', () => {
    expect(botLevel('coderabbitai[bot]', '_⚠️ Potential issue_\n\n**Charge the fee.**')).toBe(
      'risk',
    );
    expect(botLevel('coderabbitai', '_🛠️ Refactor suggestion_\n\n**Extract a helper.**')).toBe(
      'look',
    );
    expect(botLevel('coderabbitai', 'Consider renaming this.')).toBe('look');
  });

  it("botLevel uses only that bot's own labels", () => {
    expect(botLevel('some-other-bot[bot]', '_⚠️ Potential issue_')).toBe('look');
    expect(botLevel('copilot-pull-request-reviewer', 'Potential issue here')).toBe('look');
  });

  it('botName shows known bots by name and others by login', () => {
    expect(botName('coderabbitai[bot]')).toBe('CodeRabbit');
    expect(botName('copilot-pull-request-reviewer')).toBe('Copilot');
    expect(botName('lint-helper[bot]')).toBe('lint-helper');
  });

  it('botTitle skips the label line and strips markdown', () => {
    expect(botTitle('_⚠️ Potential issue_\n\n**Charge the fee before saving.**\n\nMore text')).toBe(
      'Charge the fee before saving.',
    );
    expect(botTitle('_🛠️ Refactor suggestion_\n\nUse `repay_fee` here.')).toBe(
      'Use repay_fee here.',
    );
    expect(botTitle('**⚠️**\nKeep snake_case_names as they are.')).toBe(
      'Keep snake_case_names as they are.',
    );
    expect(botTitle('_⚠️ Potential issue_ | _🟠 Major_\n\n**Charge the fee once.**')).toBe(
      'Charge the fee once.',
    );
    expect(botTitle('_🟠 Major_\nCharge the fee once.')).toBe('Charge the fee once.');
    expect(botTitle('_⚠️ Potential issue_ | _🟠 Major_')).toBe('');
    const long = botTitle('x'.repeat(150));
    expect(long).toHaveLength(100);
    expect(long.endsWith('…')).toBe(true);
  });

  it('isBotLogin is true for logins ending in [bot]', () => {
    expect(isBotLogin('coderabbitai[bot]')).toBe(true);
    expect(isBotLogin('alice')).toBe(false);
  });
});
