import type { Flow, Step } from '../shared/tour.js';
import type { CallMatch } from './code-lines.js';

/**
 * A line in a step's code that leads to another step of its flow. Found by the code check
 * only: a proven or name-matched link, or a call site that names a step. A link that only
 * the tour claims is left out, so a badge never shows a guess as a fact.
 */
export type StepTarget = {
  line: number;
  step: Step;
  /** The step's 1-based number in the flow. */
  no: number;
  /** The step after this one in the flow. */
  next: boolean;
  /** Helpers between the call on this line and the step; empty for a direct call. */
  via: string[];
};

/** Where in a line a badge goes: a string index into the line's text. */
export type PlacedBadge = { at: number; target: StepTarget };

/** Every line of `step` that leads to another step of `flow`, by line, then step number. */
export function stepTargets(flow: Flow, step: Step): StepTarget[] {
  const index = flow.steps.indexOf(step);
  const nextId = flow.steps[index + 1]?.id;
  const found = new Map<string, StepTarget>();
  const add = (line: number, toId: string, via: string[]) => {
    const no = flow.steps.findIndex((s) => s.id === toId);
    if (no < 0 || toId === step.id) return;
    const key = `${line} ${toId}`;
    const had = found.get(key);
    if (had) {
      if (had.via.length === 0) had.via = via;
      return;
    }
    found.set(key, { line, step: flow.steps[no]!, no: no + 1, next: toId === nextId, via });
  };
  for (const link of flow.links ?? []) {
    if (link.from !== step.id) continue;
    if (link.check !== 'proven' && link.check !== 'name-match') continue;
    add(link.line, link.to, link.via ?? []);
  }
  for (const site of step.callSites ?? []) {
    if (site.toStep !== undefined) add(site.line, site.toStep, []);
  }
  return [...found.values()].sort((a, b) => a.line - b.line || a.no - b.no);
}

/** The last part of a dotted name: `OrderService.Place` → `Place`. */
function lastName(name: string | undefined): string | undefined {
  return name?.split('.').pop();
}

/** The call on the line that leads to `target`, if one of the line's traced calls is it. */
function callFor(target: StepTarget, matches: CallMatch[]): CallMatch | undefined {
  const bySite = matches.find((m) => m.site?.toStep === target.step.id);
  if (bySite) return bySite;
  // Through a helper: the call to the first helper on the way.
  const name = lastName(target.via[0] ?? target.step.anchor?.name ?? target.step.symbol);
  return name === undefined ? undefined : matches.find((m) => m.call.symbol === name);
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * The index just after the call whose name ends at `from`: past its argument list (and Go
 * type arguments before it), skipping strings. A name without an argument list (a function
 * passed as a value) ends at `from`. A list not closed on this line ends at the line's end.
 */
export function callEnd(text: string, from: number): number {
  const lineEnd = text.trimEnd().length;
  let i = from;
  while (text[i] === '(' || text[i] === '[') {
    const closers: string[] = [];
    let quote: string | null = null;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) {
        if (ch === '\\' && quote !== '`') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (OPEN[ch]) closers.push(OPEN[ch]);
      else if (ch === closers[closers.length - 1]) {
        closers.pop();
        if (closers.length === 0) break;
      }
    }
    if (i >= text.length) return lineEnd;
    i++;
  }
  return i;
}

/**
 * Where each badge of a line goes: right after the call that leads to its step, or at the
 * end of the code when no traced call on the line is that call (a route registration, a
 * call the line does not show by name). Sorted by place.
 */
export function placeBadges(
  text: string,
  matches: CallMatch[],
  targets: StepTarget[],
): PlacedBadge[] {
  return targets
    .map((target) => {
      const call = callFor(target, matches);
      return { at: call ? callEnd(text, call.to) : text.trimEnd().length, target };
    })
    .sort((a, b) => a.at - b.at);
}
