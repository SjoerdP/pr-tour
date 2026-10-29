import type { CheckInput, CheckOutput } from './contract.js';
import type { CheckerResult } from './runner.js';
import type { Step, Tour } from '../../shared/tour.js';

type Analysis = NonNullable<Tour['analysis']>;

/** The tour as the checker wants it: every flow's steps, with `from` and side-effect lines. */
export function checkInput(tour: Tour): CheckInput {
  return {
    flows: tour.flows.map((flow) => ({
      id: flow.id,
      steps: flow.steps.map((s) => ({
        id: s.id,
        file: s.file,
        ...(s.symbol !== undefined ? { symbol: s.symbol } : {}),
        startLine: s.startLine,
        endLine: s.endLine,
        calls: s.calls,
        ...(s.from ? { from: { step: s.from.step, line: s.from.line, how: s.from.how } } : {}),
        sideEffects: s.sideEffects.map((e) => ({
          kind: e.kind,
          label: e.label,
          ...(e.line !== undefined ? { line: e.line } : {}),
        })),
      })),
    })),
  };
}

const isFunctionStep = (s: Step) =>
  s.file.endsWith('.go') && (s.anchor !== undefined || !!s.symbol);

/**
 * How much of the tour the code check covered. Function steps are Go steps with an anchor or a
 * symbol; links count only `call` and `register` (service and event hops cannot be proven).
 */
export function coverage(tour: Tour): Analysis['coverage'] {
  const steps = tour.flows.flatMap((f) => f.steps).filter(isFunctionStep);
  const links = tour.flows
    .flatMap((f) => f.links ?? [])
    .filter((l) => l.how === 'call' || l.how === 'register');
  return {
    functionSteps: steps.length,
    anchored: steps.filter((s) => s.anchor !== undefined).length,
    links: links.length,
    proven: links.filter((l) => l.check === 'proven').length,
    foundByCode: links.filter((l) => l.source === 'code').length,
  };
}

/** A copy without the fields a check fills in, so a re-check starts clean. */
function cleared(tour: Tour): Tour {
  const copy = structuredClone(tour);
  for (const flow of copy.flows) {
    delete flow.links;
    for (const s of flow.steps) {
      delete s.anchor;
      delete s.marks;
      delete s.callSites;
    }
  }
  return copy;
}

/**
 * Puts the checker's results on the tour: anchors, marks and call sites on steps by id, links on
 * flows by id, and `analysis`. `null` means no checker ran (`engineMissing` says why). Pure.
 */
export function applyCheck(
  tour: Tour,
  result: CheckerResult<CheckOutput> | null,
  engineMissing?: string,
): Tour {
  const base = cleared(tour);
  if (result === null || !result.ok) {
    const problem = result === null ? (engineMissing ?? 'no checker ran') : result.problem;
    const analysis: Analysis = {
      engine: 'none',
      ms: result === null ? 0 : result.ms,
      degraded: false,
      coverage: coverage(base),
      problems: [problem],
    };
    return { ...base, analysis };
  }

  const out = result.output;
  const known = new Set(base.flows.flatMap((f) => f.steps.map((s) => s.id)));
  const problems = [...out.problems];
  for (const id of Object.keys(out.steps)) {
    if (!known.has(id)) problems.push(`checker returned unknown step id "${id}"; ignored`);
  }
  for (const id of Object.keys(out.links)) {
    if (!base.flows.some((f) => f.id === id)) {
      problems.push(`checker returned links for unknown flow id "${id}"; ignored`);
    }
  }

  const merged: Tour = {
    ...base,
    flows: base.flows.map((flow) => ({
      ...flow,
      ...(out.links[flow.id] ? { links: out.links[flow.id] } : {}),
      steps: flow.steps.map((s) => {
        const r = out.steps[s.id];
        if (!r) return s;
        return {
          ...s,
          ...(r.anchor ? { anchor: r.anchor } : {}),
          marks: r.marks,
          callSites: r.callSites,
        };
      }),
    })),
  };
  const analysis: Analysis = {
    engine: out.engine,
    engineVersion: out.engineVersion,
    ms: result.ms,
    degraded: out.degraded,
    coverage: coverage(merged),
    problems,
    ...(tour.analysis?.review ? { review: tour.analysis.review } : {}),
  };
  return { ...merged, analysis };
}
