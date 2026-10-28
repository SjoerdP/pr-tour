import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkTour } from '../../src/server/check.js';
import { parseDiff, type FileDiff } from '../../src/server/diff.js';
import type { Foundation, OtherItem, Range, Step, TourBody } from '../../src/shared/tour.js';

function fixture(...names: string[]): FileDiff[] {
  return names.flatMap((name) =>
    parseDiff(readFileSync(new URL(`../fixtures/${name}.diff`, import.meta.url), 'utf8')),
  );
}

function foundation(id: string, homes: Range[]): Foundation {
  return { id, kind: 'model', title: id, file: 'x', why: 'w', risk: 'skim', homes };
}

function step(id: string, homes: Range[]): Step {
  return {
    id,
    title: id,
    file: 'x',
    startLine: 1,
    endLine: 1,
    changed: true,
    why: 'w',
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes,
  };
}

function item(id: string, homes: Range[]): OtherItem {
  return { id, file: 'x', title: id, homes };
}

function body(parts: {
  foundations?: Foundation[];
  steps?: Step[];
  items?: OtherItem[];
}): TourBody {
  return {
    summary: 's',
    foundations: parts.foundations ?? [],
    flows: [
      { id: 'F1', title: 'flow', entry: { kind: 'other', label: 'l' }, steps: parts.steps ?? [] },
    ],
    other: [{ kind: 'refactor', title: 'Refactor', summary: 's', items: parts.items ?? [] }],
  };
}

const lines = (file: string, side: 'new' | 'old', start: number, end: number): Range => ({
  file,
  side,
  start,
  end,
});
const whole = (file: string): Range => ({ file, whole: true });

const UNEXPLAINED = {
  kind: 'unexplained',
  title: 'Unexplained',
  summary: 'Changed code the tour did not place anywhere.',
};

describe('checkTour', () => {
  it('all lines homed → no problems, unexplained null', () => {
    // modified.diff: deletes old 2-3, adds new 2-4 in greet.js.
    const tour = body({
      foundations: [foundation('f1', [lines('greet.js', 'old', 2, 3)])],
      steps: [step('F1.S1', [lines('greet.js', 'new', 2, 4)])],
    });
    expect(checkTour(tour, fixture('modified'))).toEqual({ problems: [], unexplained: null });
  });

  it('missing lines → one unexplained item per consecutive run', () => {
    // gaps.diff: deletes old 5, adds new 10-13 in src/app.ts.
    const tour = body({ items: [item('o1.1', [lines('src/app.ts', 'new', 10, 11)])] });
    const result = checkTour(tour, fixture('gaps'));
    expect(result.problems).toEqual([]);
    expect(result.unexplained).toMatchObject(UNEXPLAINED);
    expect(result.unexplained?.items.map((i) => i.homes)).toEqual([
      [lines('src/app.ts', 'old', 5, 5)],
      [lines('src/app.ts', 'new', 12, 13)],
    ]);
  });

  it('unexplained lines split into separate items where a run has a gap', () => {
    // Homing new 11-12 leaves 10 and 13: not consecutive, so two items.
    const tour = body({
      items: [item('o1.1', [lines('src/app.ts', 'new', 11, 12), lines('src/app.ts', 'old', 5, 5)])],
    });
    expect(checkTour(tour, fixture('gaps')).unexplained?.items.map((i) => i.homes)).toEqual([
      [lines('src/app.ts', 'new', 10, 10)],
      [lines('src/app.ts', 'new', 13, 13)],
    ]);
  });

  it('unexplained items are numbered u1, u2, … in diff order, each on its own file', () => {
    // multi.diff: a.txt (text), icon.png (binary), z.txt (text); nothing homed.
    const items = checkTour(body({}), fixture('multi')).unexplained?.items;
    expect(items?.map((i) => [i.id, i.file, i.homes])).toEqual([
      ['u1', 'a.txt', [lines('a.txt', 'old', 2, 2)]],
      ['u2', 'a.txt', [lines('a.txt', 'new', 2, 2)]],
      ['u3', 'icon.png', [whole('icon.png')]],
      ['u4', 'z.txt', [lines('z.txt', 'old', 2, 2)]],
      ['u5', 'z.txt', [lines('z.txt', 'new', 2, 2)]],
    ]);
    for (const i of items ?? []) expect(i.title).not.toBe('');
  });

  it('double home → problem naming both ids', () => {
    const tour = body({
      foundations: [foundation('f1', [lines('greet.js', 'new', 2, 4)])],
      steps: [step('F1.S1', [lines('greet.js', 'new', 3, 3), lines('greet.js', 'old', 2, 3)])],
    });
    const result = checkTour(tour, fixture('modified'));
    expect(result.problems).toEqual(['greet.js:new:3 has 2 homes: f1, F1.S1']);
    expect(result.unexplained).toBeNull();
  });

  it('two overlapping ranges of the same home count as one home', () => {
    const tour = body({
      items: [
        item('o1.1', [
          lines('greet.js', 'new', 2, 4),
          lines('greet.js', 'new', 3, 4),
          lines('greet.js', 'old', 2, 3),
        ]),
      ],
    });
    expect(checkTour(tour, fixture('modified'))).toEqual({ problems: [], unexplained: null });
  });

  it('whole-file home plus a line home on the same file → double home', () => {
    const tour = body({
      foundations: [foundation('f1', [whole('greet.js')])],
      items: [item('o1.1', [lines('greet.js', 'old', 3, 3)])],
    });
    expect(checkTour(tour, fixture('modified')).problems).toEqual([
      'greet.js:old:3 has 2 homes: f1, o1.1',
    ]);
  });

  it('range with no changed lines → problem', () => {
    // new 5-7 in greet.js is context only.
    const tour = body({
      items: [item('o1.1', [whole('greet.js'), lines('greet.js', 'new', 5, 7)])],
    });
    expect(checkTour(tour, fixture('modified')).problems).toEqual([
      'o1.1 home greet.js:5-7 covers no changed lines',
    ]);
  });

  it('home on file outside PR → problem', () => {
    const tour = body({
      items: [item('o1.1', [whole('greet.js'), lines('other.js', 'new', 1, 3)])],
    });
    expect(checkTour(tour, fixture('modified')).problems).toEqual([
      'o1.1 points at other.js, which is not in this PR',
    ]);
  });

  it('whole home on file outside PR → problem', () => {
    const tour = body({ items: [item('o1.1', [whole('greet.js'), whole('other.js')])] });
    expect(checkTour(tour, fixture('modified')).problems).toEqual([
      'o1.1 points at other.js, which is not in this PR',
    ]);
  });

  it('binary file homed by whole range → no unexplained', () => {
    const tour = body({ items: [item('o1.1', [whole('logo.png')])] });
    expect(checkTour(tour, fixture('binary'))).toEqual({ problems: [], unexplained: null });
  });

  it('binary not homed → unexplained whole-file item', () => {
    expect(checkTour(body({}), fixture('binary')).unexplained?.items).toEqual([
      expect.objectContaining({ id: 'u1', file: 'logo.png', homes: [whole('logo.png')] }),
    ]);
  });

  it('a line range does not home a file without hunks', () => {
    const tour = body({ items: [item('o1.1', [lines('logo.png', 'new', 1, 1)])] });
    const result = checkTour(tour, fixture('binary'));
    expect(result.problems).toEqual(['o1.1 home logo.png:1-1 covers no changed lines']);
    expect(result.unexplained?.items.map((i) => i.homes)).toEqual([[whole('logo.png')]]);
  });

  it.each([
    ['renamed-pure', 'new-name.txt'],
    ['mode-only', 'run.sh'],
    ['added-empty', 'empty.txt'],
  ])('%s not homed → unexplained whole-file item', (name, file) => {
    const result = checkTour(body({}), fixture(name));
    expect(result.problems).toEqual([]);
    expect(result.unexplained?.items).toEqual([
      expect.objectContaining({ id: 'u1', file, homes: [whole(file)] }),
    ]);
  });

  it('pure rename homed by whole range on its new path → no unexplained', () => {
    const tour = body({ items: [item('o1.1', [whole('new-name.txt')])] });
    expect(checkTour(tour, fixture('renamed-pure'))).toEqual({ problems: [], unexplained: null });
  });

  it('renamed file: old-side home uses oldPath', () => {
    // renamed.diff: config.txt -> settings.txt, deletes old 5, adds new 5.
    const tour = body({
      items: [item('o1.1', [lines('config.txt', 'old', 5, 5), lines('settings.txt', 'new', 5, 5)])],
    });
    expect(checkTour(tour, fixture('renamed'))).toEqual({ problems: [], unexplained: null });
  });

  it('renamed file: old-side home on the new path leaves the deleted line unexplained', () => {
    const tour = body({
      items: [
        item('o1.1', [lines('settings.txt', 'old', 5, 5), lines('settings.txt', 'new', 5, 5)]),
      ],
    });
    const result = checkTour(tour, fixture('renamed'));
    expect(result.problems).toEqual(['o1.1 home settings.txt:5-5 covers no changed lines']);
    expect(result.unexplained?.items.map((i) => i.homes)).toEqual([
      [lines('config.txt', 'old', 5, 5)],
    ]);
  });

  it.each(['settings.txt', 'config.txt'])(
    'renamed file: whole range on %s covers both sides',
    (file) => {
      const tour = body({ items: [item('o1.1', [whole(file)])] });
      expect(checkTour(tour, fixture('renamed'))).toEqual({ problems: [], unexplained: null });
    },
  );

  it('whole range on one file does not home lines of another file', () => {
    const tour = body({ items: [item('o1.1', [whole('icon.png'), whole('z.txt')])] });
    expect(checkTour(tour, fixture('multi')).unexplained?.items.map((i) => i.homes)).toEqual([
      [lines('a.txt', 'old', 2, 2)],
      [lines('a.txt', 'new', 2, 2)],
    ]);
  });
});
