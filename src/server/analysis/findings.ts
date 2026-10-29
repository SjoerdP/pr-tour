import type { Flow, FlowLink as Link, Step, Tour } from '../../shared/tour.js';

/**
 * A place where the code check and Claude's tour disagree, or the code shows something the
 * tour did not say. Pass C gives these to Claude once; `pr-tour import` prints them.
 */
export type Finding =
  | { kind: 'not-found'; flow: string; link: Link }
  | { kind: 'code-only'; flow: string; link: Link }
  | { kind: 'symbol-missing'; step: string; symbol: string }
  | { kind: 'via'; flow: string; link: Link }
  | { kind: 'mark-no-call'; step: string; line: number };

/**
 * The findings of a checked tour, in tour order: per flow first its steps (symbol not found,
 * side-effect lines without a call), then its links. None when no checker ran.
 */
export function findings(tour: Tour): Finding[] {
  if (!tour.analysis || tour.analysis.engine === 'none') return [];
  const list: Finding[] = [];
  for (const flow of tour.flows) {
    for (const s of flow.steps) {
      if (s.symbol && s.file.endsWith('.go') && s.anchor?.source !== 'symbol') {
        list.push({ kind: 'symbol-missing', step: s.id, symbol: s.symbol });
      }
      for (const m of s.marks ?? []) {
        if (m.kind !== 'async' && m.source === 'claude') {
          list.push({ kind: 'mark-no-call', step: s.id, line: m.line });
        }
      }
    }
    for (const link of flow.links ?? []) {
      if (link.check === 'not-found') list.push({ kind: 'not-found', flow: flow.id, link });
      else if (link.source === 'code') list.push({ kind: 'code-only', flow: flow.id, link });
      else if (link.via && link.via.length > 0) list.push({ kind: 'via', flow: flow.id, link });
    }
  }
  return list;
}

/**
 * Whether a checker problem line says the same as one of the findings: "step X: symbol S not
 * found ..." backs a symbol-missing finding, "link A->B: ..." a not-found finding.
 */
export function repeatsFinding(problem: string, list: Finding[]): boolean {
  const symbol = /^step (\S+): symbol \S+ not found /.exec(problem);
  if (symbol) return list.some((f) => f.kind === 'symbol-missing' && f.step === symbol[1]);
  const link = /^link (\S+?)->(\S+?): /.exec(problem);
  if (link) {
    return list.some(
      (f) => f.kind === 'not-found' && f.link.from === link[1] && f.link.to === link[2],
    );
  }
  return false;
}

/** The flow holding a step, and the step's 1-based number in it. */
export function stepPlace(
  tour: Tour,
  id: string,
): { flow: Flow; step: Step; number: number } | null {
  for (const flow of tour.flows) {
    const i = flow.steps.findIndex((s) => s.id === id);
    if (i >= 0) return { flow, step: flow.steps[i]!, number: i + 1 };
  }
  return null;
}

/** `step 3 "Save the payment" (F1.S3)`, or the bare id for an unknown step. */
export function stepName(tour: Tour, id: string): string {
  const place = stepPlace(tour, id);
  return place ? `step ${place.number} "${place.step.title}" (${id})` : id;
}

/** The step ids and flow ids a finding is about. */
export function findingTargets(tour: Tour, f: Finding): { steps: string[]; flows: string[] } {
  if ('link' in f) return { steps: [f.link.from, f.link.to], flows: [f.flow] };
  const flow = stepPlace(tour, f.step)?.flow.id;
  return { steps: [f.step], flows: flow ? [flow] : [] };
}

/** One plain line about a finding, for the review prompt and `finding:` output. */
export function findingText(tour: Tour, f: Finding): string {
  switch (f.kind) {
    case 'symbol-missing': {
      const place = stepPlace(tour, f.step);
      const file = place ? ` in ${place.step.file}` : '';
      const anchor = place?.step.anchor;
      const rest = anchor ? `; the step was pinned to ${anchor.name} instead` : '';
      return `${stepName(tour, f.step)}: the code has no function ${f.symbol}${file}${rest}`;
    }
    case 'mark-no-call': {
      const mark = stepPlace(tour, f.step)?.step.marks?.find((m) => m.line === f.line);
      const what = mark ? `${mark.kind} line` : 'side-effect line';
      return `${stepName(tour, f.step)}: the ${what} ${f.line} holds no call`;
    }
    case 'not-found': {
      const note = f.link.note ? ` (${f.link.note})` : '';
      return `${stepName(tour, f.link.from)} calls ${stepName(tour, f.link.to)} at line ${f.link.line}, says the tour, but the code does not show it${note}`;
    }
    case 'code-only':
      return `the code shows ${stepName(tour, f.link.from)} reaching ${stepName(tour, f.link.to)} at line ${f.link.line}, but the tour does not say so`;
    case 'via':
      return `${stepName(tour, f.link.from)} reaches ${stepName(tour, f.link.to)} only through ${(f.link.via ?? []).join(' -> ')}`;
  }
}
