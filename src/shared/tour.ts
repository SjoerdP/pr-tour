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
});

export const TestRefSchema = z.object({ file: z.string(), name: z.string() });

export const CallRefSchema = z.object({ symbol: z.string(), file: z.string(), line });

export const RiskSchema = z.enum(['read-closely', 'skim']);

// Claude's output has no ids (the builder assigns them); a stored tour has
// them. Both schemas are built from the same shapes so they cannot drift.
function bodySchema<Id extends z.ZodType<string | undefined>>(id: Id) {
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
    homes: z.array(RangeSchema),
  });

  const flow = z.object({
    id,
    title: z.string(),
    entry: z.object({
      kind: z.enum(['http', 'job', 'event', 'cli', 'other']),
      label: z.string(),
    }),
    steps: z.array(step),
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
export const TourBodyInputSchema = bodySchema(z.string().optional());

/** A tour body with every id assigned. */
export const TourBodySchema = bodySchema(z.string());

export const TourMetaSchema = z.object({
  repo: z.string(),
  pr: z.number().int(),
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
  hashes: z.record(z.string(), z.string()),
});

export type Range = z.infer<typeof RangeSchema>;
export type SideEffect = z.infer<typeof SideEffectSchema>;
export type TestRef = z.infer<typeof TestRefSchema>;
export type CallRef = z.infer<typeof CallRefSchema>;
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
export function homeIds(tour: Tour): string[] {
  return [
    ...tour.foundations.map((f) => f.id),
    ...tour.flows.flatMap((flow) => flow.steps.map((s) => s.id)),
    ...tour.other.flatMap((g) => g.items.map((item) => item.id)),
  ];
}
