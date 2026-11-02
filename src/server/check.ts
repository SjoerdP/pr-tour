import type { OtherGroup, OtherItem, Range, TourBody } from '../shared/tour.js';
import { changedLines, type ChangedLine, type FileDiff } from './diff.js';

export type CheckResult = { problems: string[]; unexplained: OtherGroup | null };

type Home = { id: string; range: Range };

/**
 * Check that every changed line in the diff has exactly one home in the tour.
 * Lines without a home become the "Unexplained" group; everything else that is
 * wrong (double homes, homes that cover nothing, homes outside the PR) is a problem.
 * So is a step's "from" line that is not in the step it names.
 */
export function checkTour(body: TourBody, files: FileDiff[]): CheckResult {
  const homes = allHomes(body);
  const problems: string[] = [];
  const unhomed: ChangedLine[] = [];
  const used = new Set<Home>();

  for (const file of files) {
    for (const changed of changedLines([file])) {
      const containing = homes.filter((h) => contains(h.range, changed, file));
      for (const h of containing) used.add(h);
      const ids = [...new Set(containing.map((h) => h.id))];
      if (ids.length === 0) unhomed.push(changed);
      if (ids.length > 1) {
        problems.push(
          `${changed.file}:${changed.side}:${changed.line} has ${ids.length} homes: ${ids.join(', ')}`,
        );
      }
    }
  }

  const known = new Set(files.flatMap((f) => [f.path, f.oldPath]));
  for (const h of homes) {
    if (!known.has(h.range.file)) {
      problems.push(`${h.id} points at ${h.range.file}, which is not in this PR`);
    } else if (!used.has(h)) {
      problems.push(`${h.id} home ${describeRange(h.range)} covers no changed lines`);
    }
  }

  problems.push(...fromProblems(body));
  return { problems, unexplained: unexplainedGroup(unhomed) };
}

/**
 * Fix homes Claude put on the wrong side of the diff: a line range that covers no changed
 * line on its side, but does on the other side (Claude often writes `old` for added lines).
 * Such a home moves to the other side, unless that puts lines in two places; when the same
 * place already has those lines, the home is removed instead. After that, a range that
 * covers nothing on either side is removed when the same place has another range in that
 * file that does cover changes (Claude adds old-side ranges for the code around a change).
 * Each fix is one line in `fixes`; homes that cannot be fixed this way are left for
 * `checkTour` to report.
 */
export function fixSides(body: TourBody, files: FileDiff[]): { body: TourBody; fixes: string[] } {
  const fixed = structuredClone(body);
  const owners = [
    ...fixed.foundations,
    ...fixed.flows.flatMap((flow) => flow.steps),
    ...fixed.other.flatMap((g) => g.items),
  ];
  const changed = changedLines(files).filter((l) => l.line > 0);
  const fixes: string[] = [];
  const fileOf = (path: string) => files.find((f) => f.path === path || f.oldPath === path);
  const inRange = (range: Range) =>
    changed.filter((l) => {
      const file = fileOf(l.file);
      return file !== undefined && contains(range, l, file);
    });
  /** A line range that covers no changed line, its file, and the same lines on the other side. */
  const emptyRange = (range: Range) => {
    if ('whole' in range || inRange(range).length > 0) return null;
    const file = fileOf(range.file);
    if (!file) return null;
    const side = range.side === 'old' ? ('new' as const) : ('old' as const);
    const flipped: Range = { ...range, file: side === 'new' ? file.path : file.oldPath, side };
    return { range, file, side, flipped };
  };

  for (const owner of owners) {
    for (const home of [...owner.homes]) {
      const empty = emptyRange(home);
      if (!empty) continue;
      const { range, file, side, flipped } = empty;
      const lines = inRange(flipped);
      if (lines.length === 0) continue;
      const homedBy = (o: { homes: Range[] }) => (l: ChangedLine) =>
        o.homes.some((h) => h !== range && contains(h, l, file));
      if (owners.some((o) => o !== owner && lines.some(homedBy(o)))) continue;
      const where = `${range.file}:${range.start}-${range.end}`;
      const at = owner.homes.indexOf(range);
      if (lines.every(homedBy(owner))) {
        owner.homes.splice(at, 1);
        fixes.push(
          `${owner.id}: removed ${where} on the ${range.side} side. Nothing changed there, and ${owner.id} already has the ${side} lines.`,
        );
      } else {
        owner.homes[at] = flipped;
        fixes.push(`${owner.id}: moved ${where} from the ${range.side} side to the ${side} side.`);
      }
    }
  }

  for (const owner of owners) {
    for (const home of [...owner.homes]) {
      const empty = emptyRange(home);
      if (!empty || inRange(empty.flipped).length > 0) continue;
      const { range, file } = empty;
      const sameFile = (h: Range) => h.file === file.path || h.file === file.oldPath;
      if (!owner.homes.some((h) => h !== range && sameFile(h) && inRange(h).length > 0)) continue;
      owner.homes.splice(owner.homes.indexOf(range), 1);
      fixes.push(
        `${owner.id}: removed ${range.file}:${range.start}-${range.end} on the ${range.side} side. Nothing changed there on either side, and ${owner.id} has the changed lines of this file in another range.`,
      );
    }
  }
  return { body: fixed, fixes };
}

/** Steps whose "from" line lies outside the calling step's lines. */
function fromProblems(body: TourBody): string[] {
  return body.flows.flatMap((flow) =>
    flow.steps.flatMap((s) => {
      const caller = s.from && flow.steps[s.from.step - 1];
      if (!s.from || !caller) return [];
      const { line } = s.from;
      if (caller.startLine <= line && line <= caller.endLine) return [];
      const where = `${caller.file}:${caller.startLine}-${caller.endLine}`;
      return [`${s.id} "from" line ${line} is not in step ${s.from.step} (${where})`];
    }),
  );
}

function allHomes(body: TourBody): Home[] {
  const owners = [
    ...body.foundations,
    ...body.flows.flatMap((flow) => flow.steps),
    ...body.other.flatMap((g) => g.items),
  ];
  return owners.flatMap((o) => o.homes.map((range) => ({ id: o.id, range })));
}

/** `whole` contains every line of the file on both sides, so it matches the old or new path. */
export function contains(range: Range, changed: ChangedLine, file: FileDiff): boolean {
  if ('whole' in range) return range.file === file.path || range.file === file.oldPath;
  return (
    range.file === changed.file &&
    range.side === changed.side &&
    range.start <= changed.line &&
    changed.line <= range.end
  );
}

function describeRange(range: Range): string {
  return 'whole' in range ? range.file : `${range.file}:${range.start}-${range.end}`;
}

/** Merge unhomed lines into consecutive runs per file and side, in first-seen order. */
function unexplainedGroup(unhomed: ChangedLine[]): OtherGroup | null {
  if (unhomed.length === 0) return null;

  const byKey = new Map<string, ChangedLine[]>();
  for (const l of unhomed) {
    const key = `${l.side}\0${l.file}`;
    const list = byKey.get(key) ?? [];
    list.push(l);
    byKey.set(key, list);
  }

  const ranges: Range[] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => a.line - b.line);
    let run: { file: string; side: 'new' | 'old'; start: number; end: number } | undefined;
    for (const l of sorted) {
      // Line 0 stands for a file without hunks; only a whole-file range can home it.
      if (l.line === 0) {
        ranges.push({ file: l.file, whole: true });
      } else if (run && l.line === run.end + 1) {
        run.end = l.line;
      } else {
        run = { file: l.file, side: l.side, start: l.line, end: l.line };
        ranges.push(run);
      }
    }
  }

  const items: OtherItem[] = ranges.map((range, i) => ({
    id: `u${i + 1}`,
    file: range.file,
    title: itemTitle(range),
    homes: [range],
  }));
  return {
    kind: 'unexplained',
    title: 'Unexplained',
    summary: 'Changed code the tour did not place anywhere.',
    items,
  };
}

function itemTitle(range: Range): string {
  if ('whole' in range) return `${range.file}: whole file`;
  const what = range.side === 'new' ? 'added' : 'deleted';
  const where =
    range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
  return `${range.file}: ${what} ${where}`;
}
