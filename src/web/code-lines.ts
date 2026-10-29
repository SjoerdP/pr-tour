// Pure helpers for the code view: which rows a focus covers, which home owns a changed
// row, and where a traced call appears in a line.

import {
  isOlderDraft,
  type DiffSide,
  type DraftComment,
  type ReviewThread,
} from '../shared/review.js';
import type { Row } from '../shared/rows.js';
import type { CallRef, CallSite, Tour } from '../shared/tour.js';
import { homeRanges, homesInOrder, homeTitle } from './homes.js';

/** Head line numbers, or base line numbers with `side: 'old'` (deleted lines). */
export type Focus = { start: number; end: number; side?: 'new' | 'old' };

/**
 * A place in a file to bring into view: a line on its side, or (`side`/`line` null) the
 * file's "Comments on this file" block.
 */
export type RevealPlace = { path: string; side: DiffSide | null; line: number | null };

/**
 * What the code view scrolls to and flashes once after a jump from the review panel: a
 * place, or `'focus'`, the start of the home shown. `seq` tells two jumps to the same place
 * apart, so a second click shows it again.
 */
export type Reveal = { at: RevealPlace | 'focus'; seq: number };

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

/** `site`: set when found by position (a call site of the code check). */
export type CallMatch = { from: number; to: number; call: CallRef; site?: CallSite };

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

/** The UTF-16 index in `text` where UTF-8 byte offset `byte` starts, or -1 (not a boundary). */
function indexOfByte(text: string, byte: number): number {
  let bytes = 0;
  let at = 0;
  for (const ch of text) {
    if (bytes === byte) return at;
    if (bytes > byte) return -1;
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    at += ch.length;
  }
  return bytes === byte ? at : -1;
}

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/**
 * The call sites on this row, by the exact columns of the callee name (head side only; a
 * deleted row has none). The columns are Go's: 1-based UTF-8 byte columns, `endCol` the
 * column just after the name. They are converted to string indexes, so a non-ASCII
 * character earlier on the line does not shift the button. A site whose columns do not
 * fall on a Go identifier of the row is dropped, never shown on the wrong text.
 */
export function siteMatches(row: Row, sites: CallSite[]): CallMatch[] {
  if (row.newNo === undefined || row.kind === 'del') return [];
  const found: CallMatch[] = [];
  for (const site of sites) {
    if (site.line !== row.newNo || site.col < 1 || site.endCol <= site.col) continue;
    const from = indexOfByte(row.text, site.col - 1);
    const to = indexOfByte(row.text, site.endCol - 1);
    if (from < 0 || to <= from) continue;
    const name = row.text.slice(from, to);
    if (!IDENTIFIER.test(name)) continue;
    found.push({
      from,
      to,
      call: { symbol: name, file: site.to.file, line: site.to.line },
      site,
    });
  }
  found.sort((a, b) => a.from - b.from);
  return found.filter((m, i) => i === 0 || m.from >= found[i - 1]!.to);
}
