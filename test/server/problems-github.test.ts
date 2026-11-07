import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/server/diff.js';
import { ProblemsGitHub, ciProblems, type CheckRunNode } from '../../src/server/problems-github.js';
import type { Tour } from '../../src/shared/tour.js';
import { fakeRunner, ok } from '../helpers/fake-runner.js';

/** The value passed for a `-f`/`-F` field, e.g. `fieldValue(args, 'owner')`. */
function fieldValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

const HEAD = 'b'.repeat(40);

// `loans/fees.go` keeps lines 36-38 and adds lines 39-42.
const files: FileDiff[] = [
  {
    path: 'loans/fees.go',
    oldPath: 'loans/fees.go',
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: 36,
        oldLines: 3,
        newStart: 36,
        newLines: 7,
        lines: [
          { kind: 'ctx', oldNo: 36, newNo: 36, text: 'func ChargeFee(l *Loan) error {' },
          { kind: 'ctx', oldNo: 37, newNo: 37, text: '\tif l == nil {' },
          { kind: 'ctx', oldNo: 38, newNo: 38, text: '\t\treturn nil' },
          { kind: 'add', newNo: 39, text: '\t}' },
          { kind: 'add', newNo: 40, text: '\tfee := l.Amount / 100' },
          { kind: 'add', newNo: 41, text: '\tl.Fees = append(l.Fees, fee)' },
          { kind: 'add', newNo: 42, text: '\treturn nil' },
        ],
      },
    ],
  },
];

const tour: Tour = {
  repo: 'acme/loans',
  pr: 42,
  baseSha: 'a'.repeat(40),
  headSha: HEAD,
  source: 'author',
  createdAt: '2026-10-27T12:00:00Z',
  summary: 'Charges a fee on repay.',
  foundations: [],
  flows: [
    {
      id: 'F1',
      title: 'Repay a loan',
      entry: { kind: 'http', label: 'POST /repay' },
      steps: [
        {
          id: 'F1.S1',
          title: 'ChargeFee',
          file: 'loans/fees.go',
          startLine: 36,
          endLine: 42,
          changed: true,
          why: 'Charges the fee.',
          risk: 'read-closely',
          sideEffects: [],
          tests: [{ file: 'loans/fees_test.go', name: 'TestChargeFee' }],
          calls: [],
          homes: [{ file: 'loans/fees.go', side: 'new', start: 39, end: 42 }],
        },
      ],
    },
  ],
  other: [],
  check: { problems: [] },
  hashes: {},
};

type Annotation = CheckRunNode['annotations']['nodes'][number];

function annotation(extra: Partial<Annotation> = {}): Annotation {
  return {
    path: 'loans/fees.go',
    annotationLevel: 'WARNING',
    title: null,
    message: 'fee is never checked for overflow',
    location: { start: { line: 40 }, end: { line: 40 } },
    ...extra,
  };
}

function run(extra: Partial<CheckRunNode> = {}): CheckRunNode {
  return {
    name: 'lint',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    detailsUrl: 'https://github.com/acme/loans/runs/1',
    summary: null,
    text: null,
    annotations: { nodes: [] },
    ...extra,
  };
}

describe('ciProblems', () => {
  it('turns an annotation on an added line into a line problem with its level', () => {
    const problems = ciProblems(
      [
        run({
          annotations: {
            nodes: [
              annotation(),
              annotation({
                annotationLevel: 'FAILURE',
                title: 'Unchecked error',
                message: 'The error from append is dropped.\nCheck it.',
                location: { start: { line: 41 }, end: { line: 41 } },
              }),
              annotation({
                annotationLevel: 'NOTICE',
                message: 'Consider a constant\nfor the fee rate.',
                location: { start: { line: 42 }, end: { line: 42 } },
              }),
            ],
          },
        }),
      ],
      files,
      tour,
    );

    expect(problems).toEqual([
      {
        key: 'ci|lint|loans/fees.go|\tfee := l.Amount / 100|fee is never checked for overflow',
        level: 'risk',
        title: 'fee is never checked for overflow',
        sources: ['lint'],
        at: { kind: 'line', file: 'loans/fees.go', side: 'new', line: 40 },
        url: 'https://github.com/acme/loans/runs/1',
      },
      {
        key: 'ci|lint|loans/fees.go|\tl.Fees = append(l.Fees, fee)|Unchecked error',
        level: 'bug',
        title: 'Unchecked error',
        why: 'The error from append is dropped.\nCheck it.',
        sources: ['lint'],
        at: { kind: 'line', file: 'loans/fees.go', side: 'new', line: 41 },
        url: 'https://github.com/acme/loans/runs/1',
      },
      {
        key: 'ci|lint|loans/fees.go|\treturn nil|Consider a constant',
        level: 'look',
        title: 'Consider a constant',
        why: 'for the fee rate.',
        sources: ['lint'],
        at: { kind: 'line', file: 'loans/fees.go', side: 'new', line: 42 },
        url: 'https://github.com/acme/loans/runs/1',
      },
    ]);
  });

  it('drops annotations on unchanged lines and outside the PR', () => {
    const problems = ciProblems(
      [
        run({
          annotations: {
            nodes: [
              annotation({ location: { start: { line: 12 }, end: { line: 12 } } }),
              annotation({ location: { start: { line: 37 }, end: { line: 37 } } }),
              annotation({
                path: '.github',
                annotationLevel: 'FAILURE',
                message: 'Process completed with exit code 1.',
                location: { start: { line: 1 }, end: { line: 1 } },
              }),
              annotation({ path: 'loans/other.go' }),
            ],
          },
        }),
      ],
      files,
      tour,
    );

    expect(problems).toEqual([]);
  });

  it('a failed run with kept annotations adds no card of its own', () => {
    const problems = ciProblems(
      [
        run({
          conclusion: 'FAILURE',
          summary: '--- FAIL: TestChargeFee (0.01s)',
          annotations: { nodes: [annotation()] },
        }),
      ],
      files,
      tour,
    );

    expect(problems.map((p) => p.at.kind)).toEqual(['line']);
  });

  it('a failed run without annotations is one PR-wide problem', () => {
    const problems = ciProblems(
      [
        run({
          name: 'build',
          conclusion: 'TIMED_OUT',
          // Only GitHub Actions' own note, which is on no changed line.
          annotations: {
            nodes: [
              annotation({
                path: '.github',
                annotationLevel: 'FAILURE',
                message: 'Process completed with exit code 1.',
                location: { start: { line: 1 }, end: { line: 1 } },
              }),
            ],
          },
        }),
      ],
      files,
      tour,
    );

    expect(problems).toEqual([
      {
        key: `ci|${HEAD}|build|`,
        level: 'bug',
        title: 'CI check "build" fails',
        sources: ['CI'],
        at: { kind: 'pr' },
        url: 'https://github.com/acme/loans/runs/1',
      },
    ]);
  });

  it('places a failed run on a step when a step test name is in its summary', () => {
    const problems = ciProblems(
      [
        run({
          name: 'test',
          conclusion: 'FAILURE',
          summary: '--- FAIL: TestChargeFee (0.01s)',
        }),
        // A longer name that only starts with the step's test is not a match.
        run({
          name: 'test-race',
          conclusion: 'STARTUP_FAILURE',
          text: '--- FAIL: TestChargeFeeTwice (0.01s)',
        }),
      ],
      files,
      tour,
    );

    expect(problems).toEqual([
      {
        key: `ci|${HEAD}|test|TestChargeFee`,
        level: 'bug',
        title: 'Test TestChargeFee fails in CI',
        sources: ['CI'],
        at: { kind: 'step', test: 'TestChargeFee' },
        url: 'https://github.com/acme/loans/runs/1',
      },
      {
        key: `ci|${HEAD}|test-race|`,
        level: 'bug',
        title: 'CI check "test-race" fails',
        sources: ['CI'],
        at: { kind: 'pr' },
        url: 'https://github.com/acme/loans/runs/1',
      },
    ]);
  });

  it('a successful run adds nothing', () => {
    const problems = ciProblems(
      [run({ conclusion: 'SUCCESS', summary: '--- FAIL: TestChargeFee (0.01s)' })],
      files,
      tour,
    );

    expect(problems).toEqual([]);
  });
});

describe('ProblemsGitHub.checkRuns', () => {
  it('asks for the given commit and reads pending', async () => {
    const runs = [run({ conclusion: null, status: 'IN_PROGRESS' })];
    const { run: runner, calls } = fakeRunner(
      ok(
        JSON.stringify({
          data: {
            repository: {
              object: {
                statusCheckRollup: { state: 'PENDING' },
                checkSuites: { nodes: [{ checkRuns: { nodes: runs } }] },
              },
            },
          },
        }),
      ),
    );

    const result = await new ProblemsGitHub(runner).checkRuns('acme/loans', HEAD);

    expect(result).toEqual({ runs, pending: true });
    const args = calls[0]?.args ?? [];
    expect(calls[0]?.cmd).toBe('gh');
    expect(fieldValue(args, 'owner')).toBe('acme');
    expect(fieldValue(args, 'name')).toBe('loans');
    expect(fieldValue(args, 'sha')).toBe(HEAD);
    expect(fieldValue(args, 'query')).toContain('object(oid: $sha)');
    expect(fieldValue(args, 'query')).not.toContain(HEAD);
  });

  it('reads a finished commit as not pending, and a missing one as no runs', async () => {
    const done = fakeRunner(
      ok(
        JSON.stringify({
          data: {
            repository: {
              object: {
                statusCheckRollup: { state: 'SUCCESS' },
                checkSuites: { nodes: [{ checkRuns: { nodes: [run()] } }] },
              },
            },
          },
        }),
      ),
    );
    expect(await new ProblemsGitHub(done.run).checkRuns('acme/loans', HEAD)).toEqual({
      runs: [run()],
      pending: false,
    });

    const missing = fakeRunner(ok(JSON.stringify({ data: { repository: { object: null } } })));
    expect(await new ProblemsGitHub(missing.run).checkRuns('acme/loans', HEAD)).toEqual({
      runs: [],
      pending: false,
    });
  });
});
