import { describe, expect, it } from 'vitest';
import type { Hunk } from '../../src/shared/diff.js';
import { buildRows, changeBlocks, foldRows, type Row } from '../../src/shared/rows.js';

function lines(prefix: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${prefix}${i}`);
  return out;
}

function text(ls: string[]): string {
  return ls.map((l) => `${l}\n`).join('');
}

function ctx(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'ctx', text: `c${i}` }) satisfies Row);
}

const change: Row = { kind: 'add', text: 'x' };

describe('buildRows', () => {
  it('modified: deleted lines sit where the hunk puts them and numbers continue after', () => {
    const oldLines = lines('line ', 1, 10);
    const newLines = [...oldLines];
    newLines[4] = 'line 5 changed';
    const hunk: Hunk = {
      oldStart: 2,
      oldLines: 7,
      newStart: 2,
      newLines: 7,
      lines: [
        { kind: 'ctx', oldNo: 2, newNo: 2, text: 'line 2' },
        { kind: 'ctx', oldNo: 3, newNo: 3, text: 'line 3' },
        { kind: 'ctx', oldNo: 4, newNo: 4, text: 'line 4' },
        { kind: 'del', oldNo: 5, text: 'line 5' },
        { kind: 'add', newNo: 5, text: 'line 5 changed' },
        { kind: 'ctx', oldNo: 6, newNo: 6, text: 'line 6' },
        { kind: 'ctx', oldNo: 7, newNo: 7, text: 'line 7' },
        { kind: 'ctx', oldNo: 8, newNo: 8, text: 'line 8' },
      ],
    };

    const rows = buildRows(text(newLines), text(oldLines), [hunk]);

    expect(rows).toHaveLength(11);
    expect(rows[0]).toEqual({ kind: 'ctx', oldNo: 1, newNo: 1, text: 'line 1' });
    expect(rows[4]).toEqual({ kind: 'del', oldNo: 5, text: 'line 5' });
    expect(rows[5]).toEqual({ kind: 'add', newNo: 5, text: 'line 5 changed' });
    expect(rows[6]).toEqual({ kind: 'ctx', oldNo: 6, newNo: 6, text: 'line 6' });
    expect(rows[10]).toEqual({ kind: 'ctx', oldNo: 10, newNo: 10, text: 'line 10' });
  });

  it('modified: a pure deletion is placed after the line the hunk names', () => {
    // "@@ -3 +2,0 @@": old line 3 removed, nothing added; it goes after new line 2.
    const oldLines = lines('l', 1, 5);
    const newLines = ['l1', 'l2', 'l4', 'l5'];
    const hunk: Hunk = {
      oldStart: 3,
      oldLines: 1,
      newStart: 2,
      newLines: 0,
      lines: [{ kind: 'del', oldNo: 3, text: 'l3' }],
    };

    const rows = buildRows(text(newLines), text(oldLines), [hunk]);

    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo, r.text])).toEqual([
      ['ctx', 1, 1, 'l1'],
      ['ctx', 2, 2, 'l2'],
      ['del', 3, undefined, 'l3'],
      ['ctx', 4, 3, 'l4'],
      ['ctx', 5, 4, 'l5'],
    ]);
  });

  it('added file: every line is an add with its new number', () => {
    const rows = buildRows('a\nb\nc\n', null, [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: 'add', newNo: 1, text: 'a' },
          { kind: 'add', newNo: 2, text: 'b' },
          { kind: 'add', newNo: 3, text: 'c' },
        ],
      },
    ]);

    expect(rows).toEqual([
      { kind: 'add', newNo: 1, text: 'a' },
      { kind: 'add', newNo: 2, text: 'b' },
      { kind: 'add', newNo: 3, text: 'c' },
    ]);
  });

  it('deleted file: every old line is a del with its old number', () => {
    const rows = buildRows(null, 'a\nb\n', []);

    expect(rows).toEqual([
      { kind: 'del', oldNo: 1, text: 'a' },
      { kind: 'del', oldNo: 2, text: 'b' },
    ]);
  });

  it('a last line without a trailing newline is still a row', () => {
    expect(buildRows('a\nb', 'a\nb', []).map((r) => r.text)).toEqual(['a', 'b']);
  });
});

describe('foldRows', () => {
  it('folds far context and keeps the change with 3 rows around it', () => {
    // 200 rows: rows 99..101 are the change (one line replaced by two).
    const oldLines = lines('l', 1, 198);
    const newLines = [...lines('l', 1, 99), 'n100', 'n101', ...lines('l', 101, 198)];
    const hunk: Hunk = {
      oldStart: 100,
      oldLines: 1,
      newStart: 100,
      newLines: 2,
      lines: [
        { kind: 'del', oldNo: 100, text: 'l100' },
        { kind: 'add', newNo: 100, text: 'n100' },
        { kind: 'add', newNo: 101, text: 'n101' },
      ],
    };
    const rows = buildRows(text(newLines), text(oldLines), [hunk]);
    expect(rows).toHaveLength(200);

    expect(foldRows(rows, [])).toEqual([
      { kind: 'fold', from: 0, to: 95, count: 96 },
      { kind: 'rows', from: 96, to: 104 },
      { kind: 'fold', from: 105, to: 199, count: 95 },
    ]);
  });

  it('keeps the step range open', () => {
    const segments = foldRows(ctx(100), [[10, 30]]);

    expect(segments).toEqual([
      { kind: 'fold', from: 0, to: 9, count: 10 },
      { kind: 'rows', from: 10, to: 30 },
      { kind: 'fold', from: 31, to: 99, count: 69 },
    ]);
  });

  it('does not fold tiny gaps between two changes', () => {
    const rows = ctx(40);
    rows[10] = change;
    rows[15] = change;

    const segments = foldRows(rows, []);

    expect(segments.filter((s) => s.kind === 'rows')).toEqual([{ kind: 'rows', from: 7, to: 18 }]);
  });

  it('shows a hidden gap of 3 rows but folds one of 4', () => {
    const shown = ctx(40);
    shown[10] = change;
    shown[20] = change; // hidden: 14..16
    const folded = ctx(40);
    folded[10] = change;
    folded[21] = change; // hidden: 14..17

    expect(foldRows(shown, []).filter((s) => s.kind === 'rows')).toEqual([
      { kind: 'rows', from: 7, to: 23 },
    ]);
    expect(foldRows(folded, []).slice(1, 4)).toEqual([
      { kind: 'rows', from: 7, to: 13 },
      { kind: 'fold', from: 14, to: 17, count: 4 },
      { kind: 'rows', from: 18, to: 24 },
    ]);
  });

  it('shows short hidden runs at the file edges instead of folding them', () => {
    const rows = ctx(12);
    rows[5] = change; // context 2..8; hidden 0..1 and 9..11

    expect(foldRows(rows, [])).toEqual([{ kind: 'rows', from: 0, to: 11 }]);
  });

  it('respects a custom context size', () => {
    const rows = ctx(30);
    rows[15] = change;

    expect(foldRows(rows, [], 1)).toEqual([
      { kind: 'fold', from: 0, to: 13, count: 14 },
      { kind: 'rows', from: 14, to: 16 },
      { kind: 'fold', from: 17, to: 29, count: 13 },
    ]);
  });

  it('clamps keepOpen ranges that run past the file', () => {
    expect(foldRows(ctx(10), [[-5, 50]])).toEqual([{ kind: 'rows', from: 0, to: 9 }]);
  });

  it('an empty file has no segments', () => {
    expect(foldRows([], [])).toEqual([]);
  });

  it('handles a very large file', () => {
    const rows = ctx(200_000);
    rows[100_000] = change;

    expect(foldRows(rows, [])).toEqual([
      { kind: 'fold', from: 0, to: 99_996, count: 99_997 },
      { kind: 'rows', from: 99_997, to: 100_003 },
      { kind: 'fold', from: 100_004, to: 199_999, count: 99_996 },
    ]);
  });
});

describe('changeBlocks', () => {
  it('returns one block per run of changed rows', () => {
    const rows = ctx(10);
    rows[2] = { kind: 'del', text: 'x' };
    rows[3] = { kind: 'add', text: 'y' };
    rows[7] = change;
    rows[9] = { kind: 'del', text: 'z' };

    expect(changeBlocks(rows)).toEqual([
      { from: 2, to: 3 },
      { from: 7, to: 7 },
      { from: 9, to: 9 },
    ]);
  });

  it('returns no blocks when nothing changed', () => {
    expect(changeBlocks(ctx(5))).toEqual([]);
  });
});
