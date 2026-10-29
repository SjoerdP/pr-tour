// The tour's homes in the order the web shows them (outline and j/k).

import type {
  Flow,
  Foundation,
  OtherGroup,
  OtherItem,
  Range,
  Step,
  StepFrom,
  Tour,
} from '../shared/tour.js';

/** One place a changed line can live: a foundation, a flow step or an other-changes item. */
export type Home =
  | { kind: 'foundation'; id: string; foundation: Foundation }
  | { kind: 'step'; id: string; step: Step; flow: Flow }
  | { kind: 'other'; id: string; item: OtherItem; group: OtherGroup };

/**
 * The other-changes groups in display order: unexplained lines first (they are the ones
 * most worth a look), then the rest in tour order.
 */
export function otherGroupsInOrder(tour: Tour): OtherGroup[] {
  return [
    ...tour.other.filter((g) => g.kind === 'unexplained'),
    ...tour.other.filter((g) => g.kind !== 'unexplained'),
  ];
}

/** Every home in the order the outline lists them, which is also the j/k order. */
export function homesInOrder(tour: Tour): Home[] {
  return [
    ...tour.foundations.map((foundation): Home => ({
      kind: 'foundation',
      id: foundation.id,
      foundation,
    })),
    ...tour.flows.flatMap((flow) =>
      flow.steps.map((step): Home => ({ kind: 'step', id: step.id, step, flow })),
    ),
    ...otherGroupsInOrder(tour).flatMap((group) =>
      group.items.map((item): Home => ({ kind: 'other', id: item.id, item, group })),
    ),
  ];
}

export function homeTitle(home: Home): string {
  switch (home.kind) {
    case 'foundation':
      return home.foundation.title;
    case 'step':
      return home.step.title;
    case 'other':
      return home.item.title;
  }
}

/** The changed-line ranges a home owns. */
export function homeRanges(home: Home): Range[] {
  switch (home.kind) {
    case 'foundation':
      return home.foundation.homes;
    case 'step':
      return home.step.homes;
    case 'other':
      return home.item.homes;
  }
}

/**
 * The step of `flow` whose code holds `line` of `file`: where following a call into the
 * flow lands. Undefined when the call leads outside the flow's steps.
 */
export function flowStepAt(flow: Flow, file: string, line: number): Step | undefined {
  return flow.steps.find((s) => s.file === file && s.startLine <= line && line <= s.endLine);
}

/** How the flow gets to a step: the calling step, the line of the call, and how. */
export type CameFrom = {
  caller: Step;
  /** The caller's 1-based number in the flow. */
  callerNo: number;
  /** Null when worked out from the calls, which say where a function is, not where it is called. */
  line: number | null;
  how: StepFrom['how'];
  via: string | undefined;
  /** Steps between the caller and this one, which returned before the call: [first, last]. */
  returned: [number, number] | null;
};

/**
 * Where `step` is called from, by its `from`. A tour from before `from` existed has only the
 * calls each step lists: then the nearest earlier step that calls into this one. Null for a
 * flow's first step, or when nothing says.
 */
export function cameFrom(flow: Flow, step: Step): CameFrom | null {
  const no = flow.steps.indexOf(step) + 1;
  const link = step.from ? fromLink(flow, step.from) : callLink(flow, step, no);
  if (!link) return null;
  const { callerNo } = link;
  return { ...link, returned: callerNo < no - 1 ? [callerNo + 1, no - 1] : null };
}

function fromLink(flow: Flow, from: StepFrom): Omit<CameFrom, 'returned'> | null {
  const caller = flow.steps[from.step - 1];
  if (!caller) return null;
  return { caller, callerNo: from.step, line: from.line, how: from.how, via: from.via };
}

function callLink(flow: Flow, step: Step, no: number): Omit<CameFrom, 'returned'> | null {
  for (let i = no - 2; i >= 0; i--) {
    const caller = flow.steps[i]!;
    const calls = caller.calls.some(
      (c) => c.file === step.file && step.startLine <= c.line && c.line <= step.endLine,
    );
    if (calls) return { caller, callerNo: i + 1, line: null, how: 'call', via: undefined };
  }
  return null;
}

/** True for the first step of a flow: where `[` and `]` land. */
function isFlowStart(home: Home): boolean {
  return home.kind === 'step' && home.flow.steps[0]?.id === home.id;
}

/**
 * Where `]` goes from `currentId`: the first step of the next flow. After the last flow it
 * is the first other-changes item; from a foundation, the first flow. Undefined from other
 * changes, or when there is nothing further.
 */
export function nextFlowStart(homes: Home[], currentId: string): string | undefined {
  const index = homes.findIndex((h) => h.id === currentId);
  if (index === -1 || homes[index]!.kind === 'other') return undefined;
  return homes.slice(index + 1).find((h) => isFlowStart(h) || h.kind === 'other')?.id;
}

/**
 * Where `[` goes from `currentId`: the first step of the previous flow. From the first flow
 * it is the last foundation; from other changes, the last flow. Undefined from a foundation.
 */
export function previousFlowStart(homes: Home[], currentId: string): string | undefined {
  const current = homes.find((h) => h.id === currentId);
  if (current === undefined || current.kind === 'foundation') return undefined;
  // Where the current flow (or the other changes) begins: look back from there.
  const sectionStart =
    current.kind === 'step'
      ? homes.findIndex((h) => h.id === current.flow.steps[0]?.id)
      : homes.findIndex((h) => h.kind === 'other');
  return homes.slice(0, sectionStart).findLast((h) => isFlowStart(h) || h.kind === 'foundation')
    ?.id;
}

/** The file a home's code view opens. */
export function homeFile(home: Home): string {
  switch (home.kind) {
    case 'foundation':
      return home.foundation.file;
    case 'step':
      return home.step.file;
    case 'other':
      return home.item.file;
  }
}

/**
 * True when the home owns a line of `path` on `side` in `start..end`. A file-level place
 * (`side` null) has no lines: only a whole-file range owns it.
 */
export function homeTouches(
  home: Home,
  path: string,
  side: 'new' | 'old' | null,
  start: number,
  end: number,
): boolean {
  return homeRanges(home).some((range) => {
    if (range.file !== path) return false;
    if ('whole' in range) return true;
    return side === range.side && start <= range.end && end >= range.start;
  });
}

/** The first home (in display order) that owns the place, if any. */
export function homeAt(
  tour: Tour,
  path: string,
  side: 'new' | 'old' | null,
  start: number,
  end: number = start,
): Home | undefined {
  return homesInOrder(tour).find((home) => homeTouches(home, path, side, start, end));
}

function isReadClosely(home: Home): boolean {
  if (home.kind === 'foundation') return home.foundation.risk === 'read-closely';
  if (home.kind === 'step') return home.step.risk === 'read-closely';
  return false;
}

/**
 * The homes with changed lines the reader has not seen: read-closely ones first, then the
 * rest, each in display order.
 */
export function unseenForReview(tour: Tour, isSeen: (homeId: string) => boolean): Home[] {
  const unseen = homesInOrder(tour).filter((h) => homeRanges(h).length > 0 && !isSeen(h.id));
  return [...unseen.filter(isReadClosely), ...unseen.filter((h) => !isReadClosely(h))];
}
