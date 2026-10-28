// Pure helpers for the code view: which rows a focus covers, which home owns a changed
// row, and where a traced call appears in a line.

import {
  isOlderDraft,
  type DiffSide,
  type DraftComment,
  type ReviewThread,
} from '../shared/review.js';
import type { Row } from '../shared/rows.js';
import type { CallRef, Tour } from '../shared/tour.js';
import { homeRanges, homesInOrder, homeTitle } from './homes.js';

/** Head line numbers, or base line numbers with `side: 'old'` (deleted lines). */
export type Focus = { start: number; end: number; side?: 'new' | 'old' };

/** The row indexes (inclusive) of the focus lines, or null when no row has them. */
export function focusRows(rows: Row[], focus: Focus | null): [number, number] | null {
  if (!focus) return null;
  // A deleted file has no head lines: its focus can only be on the base side.
  const old = focus.side === 'old' || rows.every((r) => r.newNo === undefined);
  let from = -1;
  let to = -1;
  rows.forEach((row, i) => {
    const no = old ? row.oldNo : row.newNo;
    if (no === undefined || no < focus.start || no > focus.end) return;
    if (from < 0) from = i;
    to = i;
  });
  return from < 0 ? null : [from, to];
}

export type Owner = { id: string; title: string };

/**
 * The home that owns each row: `owners[i]` for row `i`, undefined for context rows and
 * changed rows no home claims. Added rows match `new` ranges of `path`; deleted rows match
 * `old` ranges of `oldPath` (they differ for a renamed file).
 */
export function rowOwners(
  tour: Tour,
  rows: Row[],
  path: string,
  oldPath: string,
): Array<Owner | undefined> {
  const claims = homesInOrder(tour).flatMap((home) =>
    homeRanges(home)
      .filter((r) => r.file === path || r.file === oldPath)
      .map((range) => ({ range, owner: { id: home.id, title: homeTitle(home) } })),
  );
  return rows.map((row) => {
    if (row.kind === 'ctx') return undefined;
    const found = claims.find(({ range }) => {
      if ('whole' in range) return true;
      if (row.kind === 'add') {
        return range.side === 'new' && range.file === path && within(row.newNo, range);
      }
      return range.side === 'old' && range.file === oldPath && within(row.oldNo, range);
    });
    return found?.owner;
  });
}

function within(no: number | undefined, range: { start: number; end: number }): boolean {
  return no !== undefined && no >= range.start && no <= range.end;
}

/** The row shown with `side`'s line number `line`, or -1 when no row has it. */
export function rowOf(rows: Row[], side: DiffSide, line: number): number {
  return rows.findIndex((r) => (side === 'new' ? r.newNo : r.oldNo) === line);
}

function push<T>(map: Map<number, T[]>, at: number, item: T) {
  const list = map.get(at);
  if (list) list.push(item);
  else map.set(at, [item]);
}

/**
 * The row index each thread is shown after: the row of its (last) line on its side. Threads
 * that are outdated, file-level or on a line no row has go to -1, the block above the code.
 */
export function threadRows(rows: Row[], threads: ReviewThread[]): Map<number, ReviewThread[]> {
  const placed = new Map<number, ReviewThread[]>();
  for (const t of threads) {
    const at = t.outdated || t.side === null || t.line === null ? -1 : rowOf(rows, t.side, t.line);
    push(placed, at, t);
  }
  return placed;
}

/**
 * The row index each comment draft is shown after: the row of its last line. Drafts made on
 * another head than `headSha` (their lines may have moved) go to -1, as do lines no row has.
 */
export function draftRows(
  rows: Row[],
  drafts: DraftComment[],
  headSha: string,
): Map<number, DraftComment[]> {
  const placed = new Map<number, DraftComment[]>();
  for (const d of drafts) {
    push(placed, isOlderDraft(d, headSha) ? -1 : rowOf(rows, d.side, d.endLine), d);
  }
  return placed;
}

export type CallMatch = { from: number; to: number; call: CallRef };

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

/** Every whole-word occurrence of `word` in `text`. */
function occurrences(text: string, word: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  if (word === '') return found;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + word.length])) {
      found.push([at, at + word.length]);
    }
  }
  return found;
}

/**
 * Where the traced calls appear in `text`, in order and without overlaps. A qualified
 * symbol (`Loans.repay`) also matches its last part (`repay`), as code usually calls it.
 */
export function callMatches(text: string, calls: CallRef[]): CallMatch[] {
  const all: CallMatch[] = [];
  for (const call of calls) {
    let spots = occurrences(text, call.symbol);
    const last = call.symbol.split('.').pop() ?? '';
    if (spots.length === 0 && last !== call.symbol) spots = occurrences(text, last);
    for (const [from, to] of spots) all.push({ from, to, call });
  }
  all.sort((a, b) => a.from - b.from);
  const kept: CallMatch[] = [];
  for (const m of all) {
    const prev = kept[kept.length - 1];
    if (!prev || m.from >= prev.to) kept.push(m);
  }
  return kept;
}
