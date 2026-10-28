import type { OtherGroup, OtherItem, Range, TourBody } from '../shared/tour.js';
import { changedLines, type ChangedLine, type FileDiff } from './diff.js';

export type CheckResult = { problems: string[]; unexplained: OtherGroup | null };

type Home = { id: string; range: Range };

/**
 * Check that every changed line in the diff has exactly one home in the tour.
 * Lines without a home become the "Unexplained" group; everything else that is
 * wrong (double homes, homes that cover nothing, homes outside the PR) is a problem.
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

  return { problems, unexplained: unexplainedGroup(unhomed) };
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
function contains(range: Range, changed: ChangedLine, file: FileDiff): boolean {
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
