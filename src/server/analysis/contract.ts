import { z } from 'zod';
import { AnchorSchema, CallSiteSchema, FlowLinkSchema, MarkSchema } from '../../shared/tour.js';

/**
 * JSON contract between the Node server and the code checkers
 * (`checker/go`, binary `pr-tour-check-go`). Keep in sync with
 * `checker/go/contract.go`.
 */

/** Bumped when the contract or the analysis changes. */
export const CHECKER_VERSION = 1;

/** Input of `functions`: head-side changed lines per file. */
export type FunctionsInput = { files: Array<{ path: string; lines: number[] }> };
const line = z.number().int().min(1);

/** A function or method (`Recv.Name`) that contains a changed line. Lines are 1-based. */
export const FuncInfoSchema = z.object({
  file: z.string(),
  name: z.string(),
  startLine: line,
  endLine: line,
});
export const FunctionsOutputSchema = z.object({
  version: z.literal(CHECKER_VERSION),
  functions: z.array(FuncInfoSchema),
  /** Files that were skipped (unparsable, or outside the repository). */
  problems: z.array(z.string()).optional(),
});
export type FuncInfo = z.infer<typeof FuncInfoSchema>;
export type FunctionsOutput = z.infer<typeof FunctionsOutputSchema>;

/** A tour step as the checker sees it. */
export type CheckStep = {
  id: string;
  file: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  calls: Array<{ symbol: string; file: string; line: number }>;
  from?: { step: number; line: number; how: 'call' | 'service' | 'event' };
  sideEffects: Array<{
    kind: 'db-write' | 'event' | 'external-call';
    label: string;
    line?: number;
  }>;
};
export type CheckInput = { flows: Array<{ id: string; steps: CheckStep[] }> };

// One source of truth: the zod schemas in `shared/tour.ts` (the stored tour holds these).
export type { Anchor, Mark, CallSite, FlowLink as Link } from '../../shared/tour.js';

/**
 * What `check` prints. A step's `callSites` is present only when its function was
 * type-checked: absent means not checked, empty means checked and no calls.
 */
export const CheckOutputSchema = z.object({
  version: z.literal(CHECKER_VERSION),
  engine: z.enum(['go-types', 'go-syntax']),
  engineVersion: z.string(),
  degraded: z.boolean(),
  steps: z.record(
    z.string(),
    z.object({
      anchor: AnchorSchema.optional(),
      marks: z.array(MarkSchema),
      callSites: z.array(CallSiteSchema).optional(),
    }),
  ),
  /** Links by flow id. */
  links: z.record(z.string(), z.array(FlowLinkSchema)),
  problems: z.array(z.string()),
});
export type CheckOutput = z.infer<typeof CheckOutputSchema>;
