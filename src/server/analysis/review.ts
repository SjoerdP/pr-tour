import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Analysis, Tour } from '../../shared/tour.js';
import { findings, findingTargets, findingText, stepPlace, type Finding } from './findings.js';

/**
 * Pass C: Claude reviews the findings of the code check once, and may fix the tour's story.
 * It may change a step's symbol, the order of a flow's steps, how an unproven link works
 * (with a reason), and why notes, but only for steps and flows in a finding. Anything the
 * code proved, and homes, stay as they are.
 */
export type ReviewChange =
  | { kind: 'symbol'; step: string; symbol: string; reason: string }
  | { kind: 'order'; flow: string; steps: string[]; reason: string }
  | {
      kind: 'link-how';
      flow: string;
      from: string;
      to: string;
      how: 'service' | 'event' | 'register';
      reason: string;
    }
  | { kind: 'why'; step: string; why: string; reason: string };

const text = z.string().trim().min(1);

export const ReviewAnswerSchema: z.ZodType<{ changes: ReviewChange[] }> = z.object({
  changes: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('symbol'), step: text, symbol: text, reason: text }),
      z.object({ kind: z.literal('order'), flow: text, steps: z.array(text), reason: text }),
      z.object({
        kind: z.literal('link-how'),
        flow: text,
        from: text,
        to: text,
        how: z.enum(['service', 'event', 'register']),
        reason: text,
      }),
      z.object({ kind: z.literal('why'), step: text, why: text, reason: text }),
    ]),
  ),
});

/** Longest function text given to Claude, in lines; Claude can read the rest itself. */
const MAX_CODE_LINES = 300;

/**
 * The source of the functions of the steps in `list`, keyed by step id: the anchored lines,
 * or the step's own lines when it has no anchor. Read from the checkout; a file that cannot
 * be read, or lies outside the checkout, is left out.
 */
export function functionCode(
  worktree: string,
  tour: Tour,
  list: Finding[],
): Record<string, string> {
  const root = resolve(worktree);
  const code: Record<string, string> = {};
  for (const id of involved(tour, list).steps) {
    const step = stepPlace(tour, id)?.step;
    if (!step) continue;
    const path = resolve(root, step.file);
    if (!path.startsWith(root + sep)) continue;
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const start = step.anchor?.startLine ?? step.startLine;
    const end = step.anchor?.endLine ?? step.endLine;
    const lines = source.split('\n').slice(start - 1, end);
    const kept = lines.slice(0, MAX_CODE_LINES);
    if (lines.length > kept.length) kept.push(`[... ${lines.length - kept.length} more lines]`);
    code[id] = kept.join('\n');
  }
  return code;
}

/** Step and flow ids the findings are about, in tour order. */
function involved(tour: Tour, list: Finding[]): { steps: string[]; flows: string[] } {
  const steps = new Set<string>();
  const flows = new Set<string>();
  for (const f of list) {
    const t = findingTargets(tour, f);
    t.steps.forEach((s) => steps.add(s));
    t.flows.forEach((s) => flows.add(s));
  }
  return {
    steps: tour.flows.flatMap((f) => f.steps.map((s) => s.id)).filter((id) => steps.has(id)),
    flows: tour.flows.map((f) => f.id).filter((id) => flows.has(id)),
  };
}

/** One line about a step for the prompt: where it is, what it is pinned to, how it is reached. */
function stepLine(tour: Tour, id: string): string {
  const place = stepPlace(tour, id)!;
  const s = place.step;
  const parts = [`${id}: step ${place.number} of flow ${place.flow.id} "${place.flow.title}"`];
  parts.push(`title "${s.title}"`, `file ${s.file}, lines ${s.startLine}-${s.endLine}`);
  parts.push(s.symbol ? `symbol ${s.symbol}` : 'no symbol');
  if (s.anchor) {
    parts.push(
      `pinned by the code to ${s.anchor.name} (lines ${s.anchor.startLine}-${s.anchor.endLine})`,
    );
  }
  if (s.from) parts.push(`reached from step ${s.from.step} at line ${s.from.line} (${s.from.how})`);
  parts.push(`why: ${s.why}`);
  return `- ${parts.join('; ')}`;
}

/** The prompt for pass C: the findings, the steps and code involved, the rules, the answer shape. */
export function reviewPrompt(tour: Tour, list: Finding[], code: Record<string, string>): string {
  const { steps, flows } = involved(tour, list);
  const flowLines = flows.map((id) => {
    const flow = tour.flows.find((f) => f.id === id)!;
    return `- ${id} "${flow.title}": steps in order ${flow.steps.map((s) => s.id).join(', ')}`;
  });
  const codeBlocks = steps
    .filter((id) => code[id] !== undefined)
    .map((id) => {
      const s = stepPlace(tour, id)!.step;
      const start = s.anchor?.startLine ?? s.startLine;
      const lang = s.file.endsWith('.go') ? 'go' : '';
      return `### ${id}: ${s.file} from line ${start}\n\`\`\`${lang}\n${code[id]}\n\`\`\``;
    });
  return [
    'You wrote a code tour of a pull request. A code check compared the tour with the code',
    'and found the places below where they do not agree. Review each one against the code and',
    'fix the tour where its story is off. You can read more of the code in this checkout',
    '(Read, Grep, Glob). If a finding is fine as it is, make no change for it.',
    '',
    '## What you may change',
    '',
    '- "symbol": the function a step is about, when the step meant another function.',
    '- "order": the order of the steps in a flow. List every step id of the flow exactly once.',
    '  A step must come after the step it is reached from.',
    '- "link-how": how one step reaches another, for a link the code did not prove:',
    '  "service" (a request to another service in this repo), "event" (an event the step',
    '  handles) or "register" (registered, for example through dependency injection).',
    '- "why": the why note of a step.',
    '',
    'Every change needs a short reason of one line. The reviewer sees it.',
    '',
    '## What you may not change',
    '',
    '- Anything the code proved: where a function is, what a line calls, a proven link.',
    '- The changed lines a step covers (its homes), or any field not listed above.',
    '- Steps and flows that are not in a finding below.',
    '',
    'Changes like these are dropped.',
    '',
    '## Findings',
    '',
    ...list.map((f) => `- ${findingText(tour, f)}`),
    '',
    '## Flows in the findings',
    '',
    ...flowLines,
    '',
    '## Steps in the findings',
    '',
    ...steps.map((id) => stepLine(tour, id)),
    '',
    '## Code of these steps',
    '',
    ...(codeBlocks.length > 0 ? codeBlocks : ['(not available; read the files yourself)']),
    '',
    '## Answer',
    '',
    'Answer with one JSON object and nothing else (no prose, no fence), in this shape:',
    '',
    '{"changes": [',
    '  {"kind": "symbol", "step": "<step id>", "symbol": "<function name>", "reason": "<one line>"},',
    '  {"kind": "order", "flow": "<flow id>", "steps": ["<step id>", "..."], "reason": "<one line>"},',
    '  {"kind": "link-how", "flow": "<flow id>", "from": "<step id>", "to": "<step id>", "how": "service", "reason": "<one line>"},',
    '  {"kind": "why", "step": "<step id>", "why": "<new why note>", "reason": "<one line>"}',
    ']}',
    '',
    'With nothing to change, answer {"changes": []}.',
    '',
  ].join('\n');
}

type Allowed = { steps: Set<string>; flows: Set<string>; links: Set<string> };

const linkKey = (flow: string, from: string, to: string) => `${flow} ${from} ${to}`;

/** The tour with one change applied, or why it is dropped. Mutates `tour` only on success. */
function applyOne(tour: Tour, c: ReviewChange, allowed: Allowed): Tour | string {
  switch (c.kind) {
    case 'symbol':
    case 'why': {
      if (!allowed.steps.has(c.step)) return `step ${c.step} is not in a finding`;
      const step = stepPlace(tour, c.step)?.step;
      if (!step) return `step ${c.step} does not exist`;
      if (c.kind === 'symbol') step.symbol = c.symbol;
      else step.why = c.why;
      return tour;
    }
    case 'order': {
      if (!allowed.flows.has(c.flow)) return `flow ${c.flow} is not in a finding`;
      const flow = tour.flows.find((f) => f.id === c.flow);
      if (!flow) return `flow ${c.flow} does not exist`;
      const oldIds = flow.steps.map((s) => s.id);
      const same =
        c.steps.length === oldIds.length &&
        new Set(c.steps).size === c.steps.length &&
        c.steps.every((id) => oldIds.includes(id));
      if (!same) return `the new order of flow ${c.flow} does not list each of its steps once`;
      const newNumber = new Map(c.steps.map((id, i) => [id, i + 1]));
      const steps = c.steps.map((id) => structuredClone(flow.steps.find((s) => s.id === id)!));
      for (const [i, s] of steps.entries()) {
        if (!s.from) continue;
        const caller = oldIds[s.from.step - 1];
        const number = caller === undefined ? undefined : newNumber.get(caller);
        if (i === 0 || number === undefined || number > i) {
          return `the new order of flow ${c.flow} puts ${s.id} before the step it is reached from`;
        }
        s.from = { ...s.from, step: number };
      }
      flow.steps = steps;
      return tour;
    }
    case 'link-how': {
      const name = `the link from ${c.from} to ${c.to} in flow ${c.flow}`;
      if (!allowed.links.has(linkKey(c.flow, c.from, c.to))) return `${name} is not in a finding`;
      const flow = tour.flows.find((f) => f.id === c.flow);
      const pair = (flow?.links ?? []).filter((l) => l.from === c.from && l.to === c.to);
      const link = pair.find((l) => l.check !== 'proven');
      if (!link) return `${name} is proven by the code`;
      link.how = c.how;
      link.reason = c.reason;
      link.check = 'unchecked';
      // When the link is the step's own `from`, say the same there, so the next check agrees.
      const to = stepPlace(tour, c.to);
      const from = stepPlace(tour, c.from);
      if (to?.step.from && from && to.step.from.step === from.number && c.how !== 'register') {
        to.step.from = { ...to.step.from, how: c.how };
      }
      return tour;
    }
  }
}

/**
 * Apply Claude's review changes that the rules allow, in order. Each change that names a step,
 * flow or link not in a finding, or that would overrule the code, is dropped with a reason.
 * Pure: `tour` is not changed.
 */
export function applyReview(
  tour: Tour,
  changes: ReviewChange[],
): { tour: Tour; applied: ReviewChange[]; dropped: Array<{ change: ReviewChange; why: string }> } {
  const list = findings(tour);
  const { steps, flows } = involved(tour, list);
  const allowed: Allowed = {
    steps: new Set(steps),
    flows: new Set(flows),
    links: new Set(
      list.flatMap((f) => ('link' in f ? [linkKey(f.flow, f.link.from, f.link.to)] : [])),
    ),
  };
  let current = structuredClone(tour);
  const applied: ReviewChange[] = [];
  const dropped: Array<{ change: ReviewChange; why: string }> = [];
  for (const change of changes) {
    // Work on a copy, so a change dropped halfway leaves nothing behind.
    const result = applyOne(structuredClone(current), change, allowed);
    if (typeof result === 'string') dropped.push({ change, why: result });
    else {
      current = result;
      applied.push(change);
    }
  }
  return { tour: current, applied, dropped };
}

const HOW_TEXT = {
  service: 'a call to another service',
  event: 'an event',
  register: 'a registration',
} as const;

type ReviewRecord = NonNullable<Analysis['review']>['changes'][number];

/**
 * What an applied change did, in one short sentence for About this PR. Step numbers are the
 * ones in `after` (the reviewed tour); an order change names the old numbers.
 */
export function reviewChangeText(before: Tour, after: Tour, c: ReviewChange): ReviewRecord {
  const at = (id: string) => {
    const place = stepPlace(after, id);
    return place ? `Step ${place.number} in "${place.flow.title}"` : `Step ${id}`;
  };
  switch (c.kind) {
    case 'symbol': {
      const old = stepPlace(before, c.step)?.step.symbol;
      const not = old && old !== c.symbol ? `, not ${old}` : '';
      return {
        step: c.step,
        what: `${at(c.step)} now points at ${c.symbol}${not}`,
        reason: c.reason,
      };
    }
    case 'order': {
      const flow = before.flows.find((f) => f.id === c.flow);
      const ids = flow?.steps.map((s) => s.id) ?? [];
      const numbers = c.steps.map((id) => ids.indexOf(id) + 1).join(', ');
      const title = flow?.title ?? c.flow;
      return { what: `The steps of "${title}" now run in the order ${numbers}`, reason: c.reason };
    }
    case 'link-how': {
      const from = stepPlace(after, c.from)?.number ?? c.from;
      return {
        step: c.to,
        what: `${at(c.to)} is now reached from step ${from} by ${HOW_TEXT[c.how]}`,
        reason: c.reason,
      };
    }
    case 'why':
      return { step: c.step, what: `${at(c.step)} has a new why note`, reason: c.reason };
  }
}
