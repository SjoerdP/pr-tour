import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReplaceNeedsConfirmError,
  TourBuildError,
  TourBuilder,
  type TourBuilderDeps,
  assignIds,
  contentHash,
  finishTour,
} from '../../src/server/build.js';
import type { CheckOutput, FunctionsOutput } from '../../src/server/analysis/contract.js';
import type { CheckerResult } from '../../src/server/analysis/runner.js';
import { parseDiff } from '../../src/server/diff.js';
import type { RunResult } from '../../src/server/exec.js';
import type { PrSummary } from '../../src/server/github.js';
import { Store } from '../../src/server/store.js';
import { homeIds, type Range, type TourBodyInput, type TourMeta } from '../../src/shared/tour.js';
import { fakeRunner, ok, type RunCall } from '../helpers/fake-runner.js';

function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

/** The fixture tour body: no ids, as Claude returns it. */
function fixtureBody(): TourBodyInput {
  return JSON.parse(readFixture('tour-body.json')) as TourBodyInput;
}

// modified.diff: greet.js deletes old 2-3 and adds new 2-4.
const DIFF = readFixture('modified.diff');
const ADDED_LINE = 'const separator = ": ";';

const lines = (file: string, side: 'new' | 'old', start: number, end: number): Range => ({
  file,
  side,
  start,
  end,
});

/** A small valid body for modified.diff with the given homes on its one other item. */
function greetBody(homes: Range[]): TourBodyInput {
  return {
    summary: 'Renames the greeting parts.',
    foundations: [],
    flows: [],
    other: [
      {
        kind: 'refactor',
        title: 'Refactor',
        summary: 'Renames.',
        items: [{ file: 'greet.js', title: 'Rename', homes }],
      },
    ],
  };
}

const FULL_GREET = greetBody([lines('greet.js', 'old', 2, 3), lines('greet.js', 'new', 2, 4)]);

const meta: TourMeta = {
  repo: 'acme/greet',
  pr: 7,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  source: 'inferred',
  createdAt: '2026-10-28T12:00:00.000Z',
};

describe('assignIds', () => {
  it('assignIds numbers everything', () => {
    const body = fixtureBody();
    body.foundations[0]!.id = 'claude-made-this-up';
    body.other.push({
      kind: 'docs',
      title: 'Docs',
      summary: 's',
      items: [
        { file: 'a.md', title: 'a', homes: [] },
        { file: 'b.md', title: 'b', homes: [] },
      ],
    });

    const result = assignIds(body);

    expect(result.foundations.map((f) => f.id)).toEqual(['f1']);
    expect(result.flows.map((f) => f.id)).toEqual(['F1']);
    expect(result.flows[0]!.steps.map((s) => s.id)).toEqual(['F1.S1', 'F1.S2']);
    expect(result.other.map((g) => g.items.map((i) => i.id))).toEqual([['o1.1'], ['o2.1', 'o2.2']]);
  });
});

describe('finishTour', () => {
  it('finishTour adds unexplained group', () => {
    const body = greetBody([lines('greet.js', 'old', 2, 3), lines('greet.js', 'new', 2, 3)]);

    const tour = finishTour(body, meta, parseDiff(DIFF));

    const last = tour.other.at(-1)!;
    expect(last.kind).toBe('unexplained');
    expect(last.items).toHaveLength(1);
    expect(last.items[0]!.homes).toEqual([lines('greet.js', 'new', 4, 4)]);
    expect(tour.check.problems).toEqual([]);
  });

  it('finishTour adds no group when every line has a home', () => {
    const tour = finishTour(FULL_GREET, meta, parseDiff(DIFF));

    expect(tour.other.map((g) => g.kind)).toEqual(['refactor']);
  });

  it('finishTour keeps check problems', () => {
    const body = greetBody([lines('greet.js', 'new', 2, 4), lines('greet.js', 'old', 2, 3)]);
    body.other[0]!.items.push({
      file: 'greet.js',
      title: 'Again',
      homes: [lines('greet.js', 'new', 2, 2)],
    });

    const tour = finishTour(body, meta, parseDiff(DIFF));

    expect(tour.check.problems).toEqual(['greet.js:new:2 has 2 homes: o1.1, o1.2']);
  });

  it('finishTour hashes every home', () => {
    // Two files with the same change, and a binary file without lines.
    const diff = [
      'diff --git a/one.txt b/one.txt',
      'index 1111111..2222222 100644',
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      'diff --git a/two.txt b/two.txt',
      'index 1111111..2222222 100644',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      'diff --git a/logo.png b/logo.png',
      'index d186a24..b38c3c7 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
    const item = (file: string, homes: Range[]) => ({ file, title: file, homes });
    const body: TourBodyInput = {
      summary: 's',
      foundations: [],
      flows: [],
      other: [
        {
          kind: 'refactor',
          title: 'Refactor',
          summary: 's',
          items: [
            item('one.txt', [lines('one.txt', 'old', 1, 1), lines('one.txt', 'new', 1, 1)]),
            item('two.txt', [lines('two.txt', 'new', 1, 1), lines('two.txt', 'old', 1, 1)]),
            item('one.txt', []),
          ],
        },
      ],
    };

    const tour = finishTour(body, meta, parseDiff(diff));

    // logo.png is left unexplained, so the u1 home is hashed too.
    expect(Object.keys(tour.hashes)).toEqual(homeIds(tour));
    expect(Object.keys(tour.hashes)).toContain('u1');
    expect(tour.hashes['o1.1']).toBe(tour.hashes['o1.2']);
    expect(tour.hashes['o1.1']).toBe(contentHash(['-old', '+new']));
    expect(tour.hashes['o1.3']).not.toBe(tour.hashes['o1.1']);
  });
});

describe('finishTour and the check pass agree', () => {
  // renamed.diff: config.txt -> settings.txt, deletes old 5 and adds new 5.
  const renamed = () => parseDiff(readFixture('renamed.diff'));
  const renameBody = (homes: Range[]): TourBodyInput => ({
    summary: 's',
    foundations: [],
    flows: [],
    other: [
      {
        kind: 'refactor',
        title: 'Rename',
        summary: 's',
        items: [{ file: 'settings.txt', title: 'Rename', homes }],
      },
    ],
  });

  it('a deleted line of a renamed file is homed and hashed by its old path', () => {
    const body = renameBody([lines('config.txt', 'old', 5, 5), lines('settings.txt', 'new', 5, 5)]);

    const tour = finishTour(body, meta, renamed());

    expect(tour.check.problems).toEqual([]);
    expect(tour.other).toHaveLength(1);
    expect(tour.hashes['o1.1']).toBe(contentHash(['-line five', '+line 5']));
  });

  it('a line the check pass leaves unhomed is not in the hash either', () => {
    const body = renameBody([
      lines('settings.txt', 'old', 5, 5),
      lines('settings.txt', 'new', 5, 5),
    ]);

    const tour = finishTour(body, meta, renamed());

    expect(tour.other.at(-1)!.items.map((i) => i.homes)).toEqual([
      [lines('config.txt', 'old', 5, 5)],
    ]);
    expect(tour.hashes['o1.1']).toBe(contentHash(['+line 5']));
    expect(tour.hashes['u1']).toBe(contentHash(['-line five']));
  });
});

describe('contentHash', () => {
  it('contentHash is the sha1 of the lines joined by newlines', () => {
    expect(contentHash(['a', 'b'])).toBe('fcd127ffa1016069006ad91f3f361248f9bdf272');
  });
});

// ---- TourBuilder ----

const pr: PrSummary = {
  repo: 'acme/greet',
  number: 7,
  title: 'Rename greeting parts',
  author: 'alice',
  url: 'https://github.com/acme/greet/pull/7',
  additions: 3,
  deletions: 2,
  isDraft: false,
  updatedAt: '2026-10-27T00:00:00Z',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  viewerIsAuthor: false,
};

/** What `claude -p --output-format json` prints for a final answer `result`. */
function claudeAnswer(result: string): RunResult {
  return ok(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result }));
}

let home: string;
let store: Store;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pr-tour-build-'));
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const WORKTREE = '/worktrees/acme__greet/bbbb';
/** Where the PR branched from its base; the base branch has moved on since. */
const MERGE_BASE = 'e'.repeat(40);

/** A builder whose claude runs answer with `answers` in turn. */
const GO_DIFF = `diff --git a/x/pay.go b/x/pay.go
index 111..222 100644
--- a/x/pay.go
+++ b/x/pay.go
@@ -1,3 +1,4 @@
 package x
 
+func Pay() {}
 func Old() {}
`;
const GO_BODY: TourBodyInput = {
  summary: 'Adds Pay.',
  foundations: [],
  flows: [],
  other: [
    {
      kind: 'refactor',
      title: 'Go',
      summary: 's',
      items: [{ file: 'x/pay.go', title: 'Pay', homes: [lines('x/pay.go', 'new', 3, 3)] }],
    },
  ],
};
const TABLE: FunctionsOutput = {
  version: 1,
  functions: [{ file: 'x/pay.go', name: 'Pay', startLine: 3, endLine: 3 }],
};
const CHECK_OUT: CheckOutput = {
  version: 1,
  engine: 'go-types',
  engineVersion: 'go1.23',
  degraded: false,
  steps: {},
  links: {},
  problems: ['something odd'],
};

/** Fake checker functions that record their calls; `failing` makes both report a problem. */
function fakeChecker(failing = false) {
  const log: string[] = [];
  const inputs: unknown[] = [];
  const checker = {
    functions: (_run: unknown, root: string, input: unknown) => {
      log.push(`functions ${root}`);
      inputs.push(input);
      return Promise.resolve(
        failing
          ? { ok: false as const, problem: 'boom', ms: 1 }
          : { ok: true as const, output: TABLE, ms: 1 },
      );
    },
    check: (_run: unknown, root: string) => {
      log.push(`check ${root}`);
      const r: CheckerResult<CheckOutput> = failing
        ? { ok: false, problem: 'boom', ms: 1 }
        : { ok: true, output: CHECK_OUT, ms: 5 };
      return Promise.resolve(r);
    },
  } as unknown as TourBuilderDeps['checker'];
  return { checker, log, inputs };
}

function builder(...answers: ((call: RunCall) => RunResult)[]) {
  return builderWith({ diff: DIFF }, ...answers);
}

function builderWith(
  opts: { diff: string; checker?: ReturnType<typeof fakeChecker>; worktree?: string },
  ...answers: ((call: RunCall) => RunResult)[]
) {
  const fake = opts.checker ?? fakeChecker();
  const { run, calls } = fakeRunner((call) => {
    if (call.cmd !== 'claude') throw new Error(`unexpected command ${call.cmd}`);
    const answer = answers.shift();
    if (!answer) throw new Error('claude called too often');
    return answer(call);
  });
  /** Every GitHub and git call the checkout made, by method name. */
  const checkoutCalls: string[] = [];
  /** The SHAs the worktree and the diff were made for: `base..head`. */
  const checkoutShas: string[] = [];
  const github = {
    pr: () => {
      checkoutCalls.push('pr');
      return Promise.resolve(pr);
    },
  };
  const repos = {
    ensureWorktree: (_repo: string, _pr: number, baseSha: string, headSha: string) => {
      checkoutCalls.push('ensureWorktree');
      checkoutShas.push(`worktree ${baseSha}..${headSha}`);
      return Promise.resolve(opts.worktree ?? WORKTREE);
    },
    diffText: (_repo: string, baseSha: string, headSha: string) => {
      checkoutCalls.push('diffText');
      checkoutShas.push(`diff ${baseSha}..${headSha}`);
      return Promise.resolve(opts.diff);
    },
    mergeBase: (_repo: string, baseSha: string, headSha: string) => {
      checkoutCalls.push('mergeBase');
      return Promise.resolve(
        baseSha === pr.baseSha && headSha === pr.headSha ? MERGE_BASE : 'wrong',
      );
    },
  };
  const tours = new TourBuilder({ run, repos, github, store, home, checker: fake.checker });
  return { tours, calls, checkoutCalls, checkoutShas, fake };
}

const answer = (result: string) => () => claudeAnswer(result);
const validAnswer = answer('Here is the tour:\n```json\n' + JSON.stringify(FULL_GREET) + '\n```');

describe('TourBuilder.build', () => {
  it('build stores an inferred tour', async () => {
    const { tours } = builder(validAnswer);

    const built = await tours.build('acme/greet', 7);

    const stored = store.getTour('acme/greet', 7);
    expect(stored).toEqual(built);
    expect(stored?.source).toBe('inferred');
    expect(stored?.headSha).toBe(pr.headSha);
    // The merge base, so the old side of the diff matches the file at the tour's base.
    expect(stored?.baseSha).toBe(MERGE_BASE);
    expect(stored?.summary).toBe(FULL_GREET.summary);
  });

  it('build passes the diff as a file, not inline', async () => {
    let diffPath = '';
    let diffOnDisk = '';
    const { tours, calls } = builder(() => {
      diffPath = join(home, 'tmp', `acme__greet-7-${pr.headSha}.diff`);
      diffOnDisk = readFileSync(diffPath, 'utf8');
      return validAnswer();
    });

    await tours.build('acme/greet', 7);

    const prompt = calls[0]!.opts?.input ?? '';
    expect(prompt).toContain(diffPath);
    expect(prompt).not.toContain(ADDED_LINE);
    expect(calls[0]!.args.join(' ')).not.toContain(ADDED_LINE);
    expect(diffOnDisk).toBe(DIFF);
    expect(existsSync(diffPath)).toBe(false);
  });

  it('build runs claude read-only', async () => {
    const { tours, calls } = builder(validAnswer);

    await tours.build('acme/greet', 7);

    const { args, opts } = calls[0]!;
    expect(args.join(' ')).toContain('--allowedTools Read Grep Glob');
    expect(args.join(' ')).toContain('--tools Read,Grep,Glob');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(opts?.cwd).toBe(WORKTREE);
  });

  it('build retries once on invalid JSON', async () => {
    const { tours, calls } = builder(answer('not json'), validAnswer);

    await tours.build('acme/greet', 7);

    expect(store.getTour('acme/greet', 7)).not.toBeNull();
    expect(calls).toHaveLength(2);
    const second = calls[1]!.opts?.input ?? '';
    expect(second).toContain('No JSON object found');
    expect(calls[0]!.opts?.input).not.toContain('No JSON object found');
  });

  it('build retries with the schema error when the JSON has the wrong shape', async () => {
    const { tours, calls } = builder(answer('{"summary": 1}'), validAnswer);

    await tours.build('acme/greet', 7);

    expect(calls[1]!.opts?.input).toMatch(/summary/);
    expect(calls[1]!.opts?.input).toMatch(/expected string/i);
  });

  it('build reads an answer that is plain JSON as a whole, even with a fence inside', async () => {
    const body = { ...FULL_GREET, summary: 'Example:\n```json\n{}\n```' };
    const { tours, calls } = builder(answer(JSON.stringify(body)));

    const tour = await tours.build('acme/greet', 7);

    expect(calls).toHaveLength(1);
    expect(tour.summary).toBe(body.summary);
  });

  it('build fails after two bad answers and stores nothing', async () => {
    const { tours, calls } = builder(answer('not json'), answer('still not json'));

    const error = await tours.build('acme/greet', 7).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TourBuildError);
    expect((error as TourBuildError).details).toContain('still not json');
    expect(calls).toHaveLength(2);
    expect(store.getTour('acme/greet', 7)).toBeNull();
    expect(existsSync(join(home, 'tmp', `acme__greet-7-${pr.headSha}.diff`))).toBe(false);
  });

  it('build fails without retry when claude itself fails', async () => {
    const { tours, calls } = builder(() => ({ stdout: '', stderr: 'not logged in', code: 1 }));

    const error = await tours.build('acme/greet', 7).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TourBuildError);
    expect((error as TourBuildError).details).toContain('not logged in');
    expect(calls).toHaveLength(1);
    expect(store.getTour('acme/greet', 7)).toBeNull();
  });

  it('a failed claude run shows its first stderr line in the message', async () => {
    const { tours } = builder(() => ({
      stdout: '',
      stderr: '\n  Invalid API key · Please run /login  \nmore detail\n',
      code: 1,
    }));

    await expect(tours.build('acme/greet', 7)).rejects.toThrow(
      'Claude failed to run: Invalid API key · Please run /login',
    );
  });

  it('a failed claude run without stderr shows its exit code', async () => {
    const { tours } = builder(() => ({ stdout: '', stderr: '', code: 3 }));

    await expect(tours.build('acme/greet', 7)).rejects.toThrow('Claude failed to run: exit code 3');
  });
});

describe('TourBuilder.importAuthorTour', () => {
  it('importAuthorTour stores an author tour without calling claude', async () => {
    const { tours, calls } = builder();

    const tour = await tours.importAuthorTour('acme/greet', 7, JSON.stringify(FULL_GREET));

    expect(calls).toHaveLength(0);
    expect(tour.source).toBe('author');
    expect(tour.headSha).toBe(pr.headSha);
    expect(tour.baseSha).toBe(MERGE_BASE);
    expect(tour.check.problems).toEqual([]);
    expect(store.getTour('acme/greet', 7)).toEqual(tour);
  });

  it('importAuthorTour rejects an invalid tour and stores nothing', async () => {
    const { tours } = builder();

    await expect(tours.importAuthorTour('acme/greet', 7, '{"summary": 1}')).rejects.toThrow(
      TourBuildError,
    );
    expect(store.getTour('acme/greet', 7)).toBeNull();
  });

  it('importAuthorTour checks the tour before fetching or checking out anything', async () => {
    const { tours, checkoutCalls } = builder();

    await expect(tours.importAuthorTour('acme/greet', 7, 'not json')).rejects.toThrow(
      TourBuildError,
    );
    expect(checkoutCalls).toEqual([]);
  });

  describe('replacing a tour', () => {
    const oldTour = () =>
      finishTour(FULL_GREET, { ...meta, headSha: 'c'.repeat(40) }, parseDiff(DIFF));
    const addReply = (body: string) =>
      store.addDraft('acme/greet', 7, { kind: 'reply', threadId: 'T1', body });

    it('import refuses with drafts and no --replace (tour unchanged)', async () => {
      const before = oldTour();
      store.saveTour(before);
      addReply('one');
      addReply('two');
      const { tours, checkoutCalls } = builder();

      const error = await tours
        .importAuthorTour('acme/greet', 7, JSON.stringify(FULL_GREET))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ReplaceNeedsConfirmError);
      expect((error as ReplaceNeedsConfirmError).drafts).toBe(2);
      expect((error as Error).message).toBe(
        'This PR has 2 unsent drafts. Run again with --replace to replace the tour. The drafts are kept; drafts made on an older version will be sent as file-level comments.',
      );
      expect(store.getTour('acme/greet', 7)).toEqual(before);
      expect(checkoutCalls).toEqual([]);
    });

    it('import with --replace keeps drafts', async () => {
      store.saveTour(oldTour());
      addReply('one');
      const { tours } = builder();

      const tour = await tours.importAuthorTour('acme/greet', 7, JSON.stringify(FULL_GREET), {
        replace: true,
      });

      expect(store.getTour('acme/greet', 7)).toEqual(tour);
      expect(store.draftCount('acme/greet', 7)).toBe(1);
    });

    it('import without drafts replaces silently', async () => {
      store.saveTour(oldTour());
      const { tours } = builder();

      const tour = await tours.importAuthorTour('acme/greet', 7, JSON.stringify(FULL_GREET));

      expect(tour.headSha).toBe(pr.headSha);
      expect(store.getTour('acme/greet', 7)).toEqual(tour);
    });

    it('import with drafts but no tour yet needs no confirmation', async () => {
      addReply('one');
      const { tours } = builder();

      await tours.importAuthorTour('acme/greet', 7, JSON.stringify(FULL_GREET));

      expect(store.getTour('acme/greet', 7)).not.toBeNull();
    });
  });
});

describe('code check passes', () => {
  const goAnswer = answer(JSON.stringify(GO_BODY));

  it('build gives Claude the function table and runs the check on the worktree', async () => {
    let table = '';
    let tablePath = '';
    const { tours, calls, fake } = builderWith({ diff: GO_DIFF }, (call) => {
      tablePath = join(home, 'tmp', `acme__greet-7-${pr.headSha}.functions.json`);
      table = readFileSync(tablePath, 'utf8');
      void call;
      return goAnswer();
    });

    const tour = await tours.build('acme/greet', 7);

    expect(calls[0]!.opts?.input).toContain(tablePath);
    expect(JSON.parse(table)).toEqual(TABLE);
    expect(existsSync(tablePath)).toBe(false);
    expect(fake.inputs[0]).toEqual({ files: [{ path: 'x/pay.go', lines: [3] }] });
    expect(fake.log).toEqual([`functions ${WORKTREE}`, `check ${WORKTREE}`]);
    expect(tour.analysis?.engine).toBe('go-types');
    expect(store.getTour('acme/greet', 7)?.analysis?.engine).toBe('go-types');
  });

  it('build with no Go file runs no checker and records why', async () => {
    const { tours, fake } = builder(validAnswer);
    const tour = await tours.build('acme/greet', 7);
    expect(fake.log).toEqual([]);
    expect(tour.analysis?.engine).toBe('none');
    expect(tour.analysis?.problems).toEqual(['no Go files in this PR']);
  });

  it('a failing checker never fails the build', async () => {
    const { tours } = builderWith({ diff: GO_DIFF, checker: fakeChecker(true) }, goAnswer);
    const tour = await tours.build('acme/greet', 7);
    expect(tour.analysis?.engine).toBe('none');
    expect(tour.analysis?.problems).toEqual(['boom']);
    expect(store.getTour('acme/greet', 7)).toEqual(tour);
  });

  it('import runs pass B', async () => {
    const { tours, fake } = builderWith({ diff: GO_DIFF });
    const tour = await tours.importAuthorTour('acme/greet', 7, JSON.stringify(GO_BODY));
    expect(fake.log).toEqual([`check ${WORKTREE}`]);
    expect(tour.analysis?.problems).toEqual(['something odd']);
  });

  it('recheck runs the check again, saves, and keeps content hashes', async () => {
    const { tours, fake } = builderWith({ diff: GO_DIFF, checker: fakeChecker(true) });
    const first = await tours.importAuthorTour('acme/greet', 7, JSON.stringify(GO_BODY));
    expect(first.analysis?.engine).toBe('none');
    const good = builderWith({ diff: GO_DIFF });
    const again = await good.tours.recheck('acme/greet', 7);
    expect(good.fake.log).toEqual([`check ${WORKTREE}`]);
    expect(fake.log).toHaveLength(1);
    expect(again.analysis?.engine).toBe('go-types');
    expect(again.hashes).toEqual(first.hashes);
    expect(store.getTour('acme/greet', 7)).toEqual(again);
  });

  it('recheck checks out the stored tour’s own commits, even when the PR moved on', async () => {
    const old = finishTour(
      GO_BODY,
      { ...meta, baseSha: 'd'.repeat(40), headSha: 'c'.repeat(40) },
      parseDiff(GO_DIFF),
    );
    store.saveTour(old);
    const { tours, checkoutShas, fake } = builderWith({ diff: GO_DIFF });

    const again = await tours.recheck('acme/greet', 7);

    expect(checkoutShas).toEqual([
      `worktree ${'d'.repeat(40)}..${'c'.repeat(40)}`,
      `diff ${'d'.repeat(40)}..${'c'.repeat(40)}`,
    ]);
    expect(fake.log).toEqual([`check ${WORKTREE}`]);
    expect(again.headSha).toBe('c'.repeat(40));
    expect(again.analysis?.engine).toBe('go-types');
  });

  it('a pass A checker that throws never fails the build', async () => {
    const fake = fakeChecker();
    fake.checker.functions = () => Promise.reject(new Error('spawn EACCES'));
    const { tours, calls } = builderWith({ diff: GO_DIFF, checker: fake }, goAnswer);

    const tour = await tours.build('acme/greet', 7);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts?.input).not.toContain('.functions.json');
    expect(tour.analysis?.engine).toBe('go-types');
  });

  it('recheck without a stored tour says so', async () => {
    const { tours } = builder();
    await expect(tours.recheck('acme/greet', 7)).rejects.toThrow('No tour is stored');
  });

  it('checks a PR that only deletes lines in a Go file', async () => {
    const deleteDiff = `diff --git a/x/pay.go b/x/pay.go
index 111..222 100644
--- a/x/pay.go
+++ b/x/pay.go
@@ -1,4 +1,3 @@
 package x
 
-func Pay() {}
 func Old() {}
`;
    const body: TourBodyInput = {
      ...GO_BODY,
      other: [
        {
          kind: 'refactor',
          title: 'Go',
          summary: 's',
          items: [{ file: 'x/pay.go', title: 'Pay', homes: [lines('x/pay.go', 'old', 3, 3)] }],
        },
      ],
    };
    const { tours, fake } = builderWith({ diff: deleteDiff });
    const tour = await tours.importAuthorTour('acme/greet', 7, JSON.stringify(body));
    expect(fake.log).toEqual([`check ${WORKTREE}`]);
    expect(tour.analysis?.engine).toBe('go-types');
  });

  it('does not check a PR whose only Go file is deleted', async () => {
    const goneDiff = `diff --git a/x/pay.go b/x/pay.go
deleted file mode 100644
index 111..000
--- a/x/pay.go
+++ /dev/null
@@ -1,2 +0,0 @@
-package x
-func Pay() {}
`;
    const body: TourBodyInput = {
      ...GO_BODY,
      other: [
        {
          kind: 'refactor',
          title: 'Go',
          summary: 's',
          items: [{ file: 'x/pay.go', title: 'Pay', homes: [lines('x/pay.go', 'old', 1, 2)] }],
        },
      ],
    };
    const { tours, fake } = builderWith({ diff: goneDiff });
    const tour = await tours.importAuthorTour('acme/greet', 7, JSON.stringify(body));
    expect(fake.log).toEqual([]);
    expect(tour.analysis?.problems).toEqual(['no Go files in this PR']);
  });

  it('logs the files the function table skipped', async () => {
    const fake = fakeChecker();
    fake.checker.functions = () =>
      Promise.resolve({
        ok: true as const,
        output: { ...TABLE, problems: ['cannot read or parse x/bad.go; skipped'] },
        ms: 1,
      });
    const { tours } = builderWith({ diff: GO_DIFF, checker: fake }, goAnswer);
    const log: string[] = [];
    await tours.build('acme/greet', 7, (line) => log.push(line));
    expect(log).toContain('Function table: cannot read or parse x/bad.go; skipped');
  });

  it('functionsOf returns the table, or null without Go files', async () => {
    expect(await builderWith({ diff: GO_DIFF }).tours.functionsOf('acme/greet', 7)).toEqual(TABLE);
    expect(await builder().tours.functionsOf('acme/greet', 7)).toBeNull();
  });
});

describe('pass C: Claude reviews the findings', () => {
  // One Go step whose symbol the code does not have: pinned by range to Pay.
  const FLOW_BODY: TourBodyInput = {
    summary: 'Adds Pay.',
    foundations: [],
    flows: [
      {
        title: 'Pay',
        entry: { kind: 'http', label: 'POST /pay' },
        steps: [
          {
            title: 'Take the payment',
            symbol: 'Payy',
            file: 'x/pay.go',
            startLine: 3,
            endLine: 3,
            changed: true,
            why: 'Takes it.',
            risk: 'skim',
            sideEffects: [],
            tests: [],
            calls: [],
            homes: [lines('x/pay.go', 'new', 3, 3)],
          },
        ],
      },
    ],
    other: [],
  };
  const flowAnswer = answer(JSON.stringify(FLOW_BODY));
  const SYMBOL_CHANGE = {
    kind: 'symbol',
    step: 'F1.S1',
    symbol: 'Pay',
    reason: 'the function is called Pay',
  };
  const reviewAnswer = (changes: unknown[]) => answer(JSON.stringify({ changes }));

  /** A checker that anchors F1.S1 by symbol only when its symbol is `Pay`. */
  function anchoringChecker() {
    const fake = fakeChecker();
    const symbols: (string | undefined)[] = [];
    fake.checker.check = (_run, root, input) => {
      fake.log.push(`check ${root}`);
      const symbol = input.flows[0]?.steps[0]?.symbol;
      symbols.push(symbol);
      const source = symbol === 'Pay' ? ('symbol' as const) : ('range' as const);
      return Promise.resolve({
        ok: true as const,
        ms: 5,
        output: {
          ...CHECK_OUT,
          problems: [],
          steps: {
            'F1.S1': {
              anchor: { name: 'Pay', startLine: 3, endLine: 3, source },
              marks: [],
              callSites: [],
            },
          },
        },
      });
    };
    return { ...fake, symbols };
  }

  let worktree: string;
  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'pr-tour-wt-'));
    mkdirSync(join(worktree, 'x'));
    writeFileSync(
      join(worktree, 'x/pay.go'),
      'package x\n\nfunc Pay() { charge() }\nfunc Old() {}\n',
    );
  });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  it('asks Claude once more, applies its changes and runs pass B again', async () => {
    const checker = anchoringChecker();
    const { tours, calls } = builderWith(
      { diff: GO_DIFF, checker, worktree },
      flowAnswer,
      reviewAnswer([SYMBOL_CHANGE]),
    );

    const tour = await tours.build('acme/greet', 7);

    expect(calls).toHaveLength(2);
    const prompt = calls[1]!.opts?.input ?? '';
    expect(prompt).toContain('the code has no function Payy in x/pay.go');
    expect(prompt).toContain('func Pay() { charge() }');
    expect(prompt).not.toContain('func Old');
    const { args, opts } = calls[1]!;
    expect(args.join(' ')).toContain('--tools Read,Grep,Glob');
    expect(args.join(' ')).toContain('--allowedTools Read Grep Glob');
    expect(opts?.cwd).toBe(worktree);
    expect(opts?.timeoutMs).toBe(180_000);
    expect(checker.symbols).toEqual(['Payy', 'Pay']);
    expect(tour.flows[0]!.steps[0]!.symbol).toBe('Pay');
    expect(tour.flows[0]!.steps[0]!.anchor?.source).toBe('symbol');
    expect(tour.analysis?.review?.ms).toBeGreaterThanOrEqual(0);
    expect(tour.analysis?.review).toMatchObject({
      ran: true,
      changes: [
        {
          step: 'F1.S1',
          what: 'Step 1 in "Pay" now points at Pay, not Payy',
          reason: 'the function is called Pay',
        },
      ],
    });
    expect(tour.analysis?.problems).toEqual([]);
    expect(store.getTour('acme/greet', 7)).toEqual(tour);
  });

  it('lists a dropped change as a problem, not as a change', async () => {
    const checker = anchoringChecker();
    const { tours } = builderWith(
      { diff: GO_DIFF, checker, worktree },
      flowAnswer,
      reviewAnswer([{ kind: 'why', step: 'F9.S9', why: 'w', reason: 'r' }]),
    );

    const tour = await tours.build('acme/greet', 7);

    expect(tour.analysis?.review).toMatchObject({ ran: true, changes: [] });
    expect(tour.analysis?.problems).toHaveLength(1);
    expect(tour.analysis?.problems[0]).toContain('F9.S9');
    expect(tour.analysis?.review?.problems).toEqual(tour.analysis?.problems);
    // Nothing changed, so pass B has nothing new to check.
    expect(checker.symbols).toEqual(['Payy']);
  });

  it('keeps the pass B tour and records the problem when Claude fails', async () => {
    const checker = anchoringChecker();
    const { tours, calls } = builderWith({ diff: GO_DIFF, checker, worktree }, flowAnswer, () => ({
      stdout: '',
      stderr: 'rate limited',
      code: 1,
    }));

    const tour = await tours.build('acme/greet', 7);

    expect(calls).toHaveLength(2);
    expect(checker.symbols).toEqual(['Payy']);
    expect(tour.flows[0]!.steps[0]!.symbol).toBe('Payy');
    expect(tour.flows[0]!.steps[0]!.anchor?.source).toBe('range');
    expect(tour.analysis?.review).toMatchObject({ ran: false, changes: [] });
    expect(tour.analysis?.review?.ms).toBeGreaterThanOrEqual(0);
    expect(tour.analysis?.problems).toEqual([
      'the review by Claude failed: Claude failed to run: rate limited',
    ]);
    expect(tour.analysis?.review?.problems).toEqual([
      'the review by Claude failed: Claude failed to run: rate limited',
    ]);
    expect(store.getTour('acme/greet', 7)).toEqual(tour);
  });

  it('words a stopped review as being about the review, not the tour', async () => {
    const { tours } = builderWith(
      { diff: GO_DIFF, checker: anchoringChecker(), worktree },
      flowAnswer,
      () => ({ stdout: JSON.stringify({ is_error: true, result: 'x' }), stderr: '', code: 0 }),
    );

    const tour = await tours.build('acme/greet', 7);

    expect(tour.analysis?.problems).toEqual([
      'the review by Claude failed: Claude stopped before finishing the review.',
    ]);
  });

  it('keeps the pass B tour when Claude answers with the wrong shape', async () => {
    const checker = anchoringChecker();
    const { tours } = builderWith(
      { diff: GO_DIFF, checker, worktree },
      flowAnswer,
      answer('{"changes": [{"kind": "homes"}]}'),
    );

    const tour = await tours.build('acme/greet', 7);

    expect(checker.symbols).toEqual(['Payy']);
    expect(tour.analysis?.review?.ran).toBe(false);
    expect(tour.analysis?.problems).toHaveLength(1);
    expect(tour.analysis?.problems[0]).toMatch(
      /^the review by Claude failed: invalid answer: [^\n]+$/,
    );
  });

  it('makes no review call when there are no findings', async () => {
    const { tours, calls } = builderWith({ diff: GO_DIFF }, answer(JSON.stringify(GO_BODY)));

    const tour = await tours.build('acme/greet', 7);

    expect(calls).toHaveLength(1);
    expect(tour.analysis?.review).toBeUndefined();
  });

  it('is not run for imports', async () => {
    const checker = anchoringChecker();
    const { tours, calls } = builderWith({ diff: GO_DIFF, checker, worktree });

    const tour = await tours.importAuthorTour('acme/greet', 7, JSON.stringify(FLOW_BODY));

    expect(calls).toHaveLength(0);
    expect(checker.symbols).toEqual(['Payy']);
    expect(tour.analysis?.review).toBeUndefined();
  });
});
