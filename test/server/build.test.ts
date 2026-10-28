import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TourBuildError,
  TourBuilder,
  assignIds,
  contentHash,
  finishTour,
} from '../../src/server/build.js';
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
function builder(...answers: ((call: RunCall) => RunResult)[]) {
  const { run, calls } = fakeRunner((call) => {
    if (call.cmd !== 'claude') throw new Error(`unexpected command ${call.cmd}`);
    const answer = answers.shift();
    if (!answer) throw new Error('claude called too often');
    return answer(call);
  });
  /** Every GitHub and git call the checkout made, by method name. */
  const checkoutCalls: string[] = [];
  const github = {
    pr: () => {
      checkoutCalls.push('pr');
      return Promise.resolve(pr);
    },
  };
  const repos = {
    ensureWorktree: () => {
      checkoutCalls.push('ensureWorktree');
      return Promise.resolve(WORKTREE);
    },
    diffText: () => {
      checkoutCalls.push('diffText');
      return Promise.resolve(DIFF);
    },
    mergeBase: (_repo: string, baseSha: string, headSha: string) => {
      checkoutCalls.push('mergeBase');
      return Promise.resolve(
        baseSha === pr.baseSha && headSha === pr.headSha ? MERGE_BASE : 'wrong',
      );
    },
  };
  const tours = new TourBuilder({ run, repos, github, store, home });
  return { tours, calls, checkoutCalls };
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
});
