import { z } from 'zod';

/** A 1-based line number. */
const line = z.number().int().min(1);

/**
 * Where changed code lives. Lines are 1-based and inclusive. `new` is the head
 * version of the file, `old` the base version. `whole` covers the whole file
 * (used for binary files, which have no lines).
 */
export const RangeSchema = z.union([
  z
    .object({ file: z.string(), side: z.enum(['new', 'old']), start: line, end: line })
    .refine((r) => r.end >= r.start, { message: 'end must not be before start' }),
  z.object({ file: z.string(), whole: z.literal(true) }),
]);

export const SideEffectSchema = z.object({
  kind: z.enum(['db-write', 'event', 'external-call']),
  label: z.string(),
  /** The head line of the call that does it. Optional: the code checker finds it when absent. */
  line: line.optional(),
});

export const TestRefSchema = z.object({ file: z.string(), name: z.string() });

export const CallRefSchema = z.object({ symbol: z.string(), file: z.string(), line });

export const RiskSchema = z.enum(['read-closely', 'skim']);

/**
 * How the flow gets to a step: the line in an earlier step of the same flow that calls it.
 * `step` is that step's 1-based number in the flow (Claude's output has no ids yet) and
 * `line` a head line in its file. `how`: a function call, a request to another service in
 * this repo, or an event this step handles. `via` names a helper in between that is not a
 * step itself.
 */
export const StepFromSchema = z.object({
  step: z.number().int().min(1),
  line,
  how: z.enum(['call', 'service', 'event']),
  via: z.string().optional(),
});

/** The code range a step is pinned to, and how it was found. */
export const AnchorSchema = z.object({
  /** e.g. 'OAuthService.Authorize' */
  name: z.string(),
  startLine: line,
  endLine: line,
  source: z.enum(['symbol', 'incoming-link', 'range']),
});

/** A side effect found on a line: from the code, from Claude, or both. */
export const MarkSchema = z.object({
  line,
  kind: z.enum(['db-write', 'event', 'external-call', 'async']),
  label: z.string().optional(),
  source: z.enum(['code', 'claude', 'both']),
});

/** A call in a step, with the column range of the callee name. */
export const CallSiteSchema = z.object({
  line,
  col: z.number().int().min(0),
  endCol: z.number().int().min(0),
  /** The called function's first line. */
  to: z.object({ file: z.string(), line }),
  /** Set when the callee is another step of the tour. */
  toStep: z.string().optional(),
});

/** A link between two steps (ids) and how well the code backs it up. */
export const FlowLinkSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** The call or registration line in `from`. */
  line,
  how: z.enum(['call', 'register', 'service', 'event']),
  /** Thin wrappers in between. */
  via: z.array(z.string()).optional(),
  source: z.enum(['claude', 'code', 'both']),
  check: z.enum(['proven', 'name-match', 'not-found', 'conflict', 'unchecked']),
  note: z.string().optional(),
  reason: z.string().optional(),
});

/** What the code check found out about a tour (stored tours only). */
export const AnalysisSchema = z.object({
  engine: z.enum(['go-types', 'go-syntax', 'none']),
  engineVersion: z.string().optional(),
  ms: z.number(),
  degraded: z.boolean(),
  coverage: z.object({
    functionSteps: z.number().int(),
    anchored: z.number().int(),
    links: z.number().int(),
    proven: z.number().int(),
    foundByCode: z.number().int(),
  }),
  problems: z.array(z.string()),
  review: z
    .object({
      ran: z.boolean(),
      ms: z.number(),
      changes: z.array(
        z.object({ step: z.string().optional(), what: z.string(), reason: z.string() }),
      ),
    })
    .optional(),
});

// Claude's output has no ids (the builder assigns them); a stored tour has
// them. Both schemas are built from the same shapes so they cannot drift.
// `stored`: also take the fields the code check fills in (anchor, marks, callSites, links).
// The input schema leaves them out, so zod strips them: Claude cannot inject them.
// `requireFrom`: every step after a flow's first must say how the flow gets there. Only
// new tours must; stored tours from before `from` existed have none.
function bodySchema<Id extends z.ZodType<string | undefined>>(
  id: Id,
  requireFrom: boolean,
  stored: boolean,
) {
  const storedStep = {
    anchor: AnchorSchema.optional(),
    marks: z.array(MarkSchema).optional(),
    callSites: z.array(CallSiteSchema).optional(),
  };
  const storedFlow = { links: z.array(FlowLinkSchema).optional() };
  const foundation = z.object({
    id,
    kind: z.enum(['migration', 'model', 'config', 'dependency']),
    title: z.string(),
    file: z.string(),
    why: z.string(),
    risk: RiskSchema,
    homes: z.array(RangeSchema),
    schemaAfter: z.string().optional(),
    deployCompat: z.object({ ok: z.boolean(), note: z.string() }).optional(),
  });

  const step = z.object({
    id,
    title: z.string(),
    symbol: z.string().optional(),
    file: z.string(),
    startLine: line,
    endLine: line,
    changed: z.boolean(),
    why: z.string(),
    risk: RiskSchema,
    riskReason: z.string().optional(),
    sideEffects: z.array(SideEffectSchema),
    tests: z.array(TestRefSchema),
    calls: z.array(CallRefSchema),
    /** Left out on a flow's first step: the entry starts the flow. */
    from: StepFromSchema.optional(),
    homes: z.array(RangeSchema),
    // Typed as always present; the input schema leaves them out at runtime (see `stored`).
    ...((stored ? storedStep : {}) as typeof storedStep),
  });

  const flow = z
    .object({
      id,
      title: z.string(),
      /** What the flow does and why it is in the tour. Optional: older tours have none. */
      why: z.string().optional(),
      entry: z.object({
        kind: z.enum(['http', 'job', 'event', 'cli', 'other']),
        label: z.string(),
      }),
      steps: z.array(step),
      ...((stored ? storedFlow : {}) as typeof storedFlow),
    })
    .superRefine((flow, ctx) => {
      // Whether `from.line` lies in the calling step is a check problem, not a parse error.
      flow.steps.forEach((s, i) => {
        const path = ['steps', i, 'from'];
        if (s.from === undefined) {
          if (requireFrom && i > 0) {
            const message = `step ${i + 1} needs "from": the earlier step of this flow that calls it`;
            ctx.addIssue({ code: 'custom', path, message });
          }
        } else if (i === 0) {
          ctx.addIssue({ code: 'custom', path, message: 'the first step of a flow has no "from"' });
        } else if (s.from.step > i) {
          const message = `step ${i + 1} "from.step" must be an earlier step of this flow: 1 to ${i}`;
          ctx.addIssue({ code: 'custom', path, message });
        }
      });
    });

  const otherItem = z.object({
    id,
    file: z.string(),
    title: z.string(),
    why: z.string().optional(),
    homes: z.array(RangeSchema),
  });

  const otherGroup = z.object({
    kind: z.enum(['refactor', 'tests', 'infra', 'docs', 'generated', 'unexplained']),
    title: z.string(),
    summary: z.string(),
    items: z.array(otherItem),
  });

  return z.object({
    summary: z.string(),
    foundations: z.array(foundation),
    flows: z.array(flow),
    other: z.array(otherGroup),
  });
}

/** What Claude produces. Ids are optional; the builder assigns them. */
export const TourBodyInputSchema = bodySchema(z.string().optional(), true, false);

/** A tour body with every id assigned. */
export const TourBodySchema = bodySchema(z.string(), false, true);

export const TourMetaSchema = z.object({
  repo: z.string(),
  pr: z.number().int(),
  /** Where the PR branched from its base (the merge base): the old side of the tour's diff. */
  baseSha: z.string(),
  headSha: z.string(),
  source: z.enum(['author', 'inferred']),
  createdAt: z.string(),
});

/**
 * A stored tour. `hashes` maps every home id to its content hash. The
 * unexplained group, if any, lives in `other`.
 */
export const TourSchema = TourBodySchema.extend(TourMetaSchema.shape).extend({
  check: z.object({ problems: z.array(z.string()) }),
  analysis: AnalysisSchema.optional(),
  hashes: z.record(z.string(), z.string()),
});

export type Range = z.infer<typeof RangeSchema>;
export type SideEffect = z.infer<typeof SideEffectSchema>;
export type TestRef = z.infer<typeof TestRefSchema>;
export type CallRef = z.infer<typeof CallRefSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type Mark = z.infer<typeof MarkSchema>;
export type CallSite = z.infer<typeof CallSiteSchema>;
export type FlowLink = z.infer<typeof FlowLinkSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;
export type StepFrom = z.infer<typeof StepFromSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type TourBodyInput = z.infer<typeof TourBodyInputSchema>;
export type TourBody = z.infer<typeof TourBodySchema>;
export type Foundation = TourBody['foundations'][number];
export type Flow = TourBody['flows'][number];
export type Step = Flow['steps'][number];
export type OtherGroup = TourBody['other'][number];
export type OtherItem = OtherGroup['items'][number];
export type TourMeta = z.infer<typeof TourMetaSchema>;
export type Tour = z.infer<typeof TourSchema>;

/** JSON Schema for Claude's output (the shape of `TourBodyInputSchema`). */
export function tourBodyJsonSchema(): object {
  return z.toJSONSchema(TourBodyInputSchema);
}

/** Ids of every foundation, step and other item, in tour order. */
export function homeIds(tour: TourBody): string[] {
  return [
    ...tour.foundations.map((f) => f.id),
    ...tour.flows.flatMap((flow) => flow.steps.map((s) => s.id)),
    ...tour.other.flatMap((g) => g.items.map((item) => item.id)),
  ];
}

/**
 * Ids of the homes a reviewer has to review: those with at least one changed-line range.
 * Unchanged flow steps (no homes) are context, not review work, so progress leaves them out.
 */
export function reviewableHomeIds(tour: TourBody): string[] {
  return [
    ...tour.foundations.filter((f) => f.homes.length > 0).map((f) => f.id),
    ...tour.flows.flatMap((flow) => flow.steps.filter((s) => s.homes.length > 0).map((s) => s.id)),
    ...tour.other.flatMap((g) => g.items.filter((item) => item.homes.length > 0).map((i) => i.id)),
  ];
}

/** Index of the flow's last step with changed lines; -1 if none has any. Later steps are context. */
export function lastChangedStepIndex(flow: Flow): number {
  return flow.steps.findLastIndex((s) => s.homes.length > 0);
}
