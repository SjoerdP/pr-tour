// The whole-file view for the code view: every row of the file in display order,
// unchanged code folded away, and the runs of changes to jump between.
// All functions here are linear in the number of rows; very large files are expected.

import type { Hunk } from './diff.js';

export type Row = { kind: 'ctx' | 'add' | 'del'; newNo?: number; oldNo?: number; text: string };

/** Row indexes, inclusive. */
export type Fold = { kind: 'fold'; from: number; to: number; count: number };

export type Segment = { kind: 'rows'; from: number; to: number } | Fold;

/** Hidden runs shorter than this are shown: a fold would save almost nothing. */
const MIN_FOLD = 4;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The whole file in display order: every line of `newText`, with the deleted
 * lines inserted where the hunks put them. Hunks must be in file order, as git
 * prints them. A deleted file (`newText === null`) is every old line as `del`;
 * an added file (`oldText === null`) is every new line as `add`.
 */
export function buildRows(newText: string | null, oldText: string | null, hunks: Hunk[]): Row[] {
  if (newText === null) {
    return splitLines(oldText ?? '').map((text, i) => ({ kind: 'del', oldNo: i + 1, text }));
  }
  const newLines = splitLines(newText);
  if (oldText === null) {
    return newLines.map((text, i) => ({ kind: 'add', newNo: i + 1, text }));
  }

  const rows: Row[] = [];
  let oldNo = 1;
  let newNo = 1;
  const ctxUpTo = (lastNewNo: number) => {
    while (newNo <= lastNewNo && newNo <= newLines.length) {
      rows.push({ kind: 'ctx', oldNo, newNo, text: newLines[newNo - 1] ?? '' });
      oldNo++;
      newNo++;
    }
  };

  for (const hunk of hunks) {
    // With no new lines, newStart names the line the hunk comes after.
    ctxUpTo(hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1);
    for (const line of hunk.lines) {
      if (line.kind === 'del') {
        rows.push({ kind: 'del', oldNo: oldNo++, text: line.text });
      } else if (line.kind === 'add') {
        rows.push({ kind: 'add', newNo: newNo++, text: line.text });
      } else {
        rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.text });
      }
    }
  }
  ctxUpTo(newLines.length);
  return rows;
}

/**
 * Splits rows into visible runs and folds. Changed rows, `context` rows around
 * each change and the `keepOpen` row ranges (inclusive) stay visible; the rest
 * is folded, except hidden runs shorter than 4 rows, which are shown.
 */
export function foldRows(rows: Row[], keepOpen: Array<[number, number]>, context = 3): Segment[] {
  const n = rows.length;
  // Difference array: +1 where a visible range starts, -1 after it ends.
  const delta = new Int32Array(n + 1);
  const open = (from: number, to: number) => {
    const a = Math.max(0, from);
    const b = Math.min(n - 1, to);
    if (a > b) return;
    delta[a]! += 1;
    delta[b + 1]! -= 1;
  };
  rows.forEach((row, i) => {
    if (row.kind !== 'ctx') open(i - context, i + context);
  });
  for (const [from, to] of keepOpen) open(from, to);

  const segments: Segment[] = [];
  const pushRows = (from: number, to: number) => {
    const last = segments[segments.length - 1];
    if (last?.kind === 'rows' && last.to === from - 1) last.to = to;
    else segments.push({ kind: 'rows', from, to });
  };

  let depth = 0;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const visible = (depth += delta[i]!) > 0;
    const nextVisible = i + 1 < n && depth + delta[i + 1]! > 0;
    const runEnds = i + 1 === n || visible !== nextVisible;
    if (!runEnds) continue;
    const count = i - start + 1;
    if (visible || count < MIN_FOLD) pushRows(start, i);
    else segments.push({ kind: 'fold', from: start, to: i, count });
    start = i + 1;
  }
  return segments;
}

/** Consecutive runs of changed (non-ctx) rows, as inclusive row indexes. */
export function changeBlocks(rows: Row[]): Array<{ from: number; to: number }> {
  const blocks: Array<{ from: number; to: number }> = [];
  rows.forEach((row, i) => {
    if (row.kind === 'ctx') return;
    const last = blocks[blocks.length - 1];
    if (last && last.to === i - 1) last.to = i;
    else blocks.push({ from: i, to: i });
  });
  return blocks;
}
