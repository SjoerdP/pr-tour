import type { Anchor, Mark, CallSite, FlowLink as Link } from '../../shared/tour.js';

/**
 * JSON contract between the Node server and the code checkers
 * (`checker/go`, binary `pr-tour-check-go`). Keep in sync with
 * `checker/go/contract.go`.
 */

/** Bumped when the contract or the analysis changes. */
export const CHECKER_VERSION = 1;

/** Input of `functions`: head-side changed lines per file. */
export type FunctionsInput = { files: Array<{ path: string; lines: number[] }> };
/** A function or method (`Recv.Name`) that contains a changed line. Lines are 1-based. */
export type FuncInfo = { file: string; name: string; startLine: number; endLine: number };
export type FunctionsOutput = { version: number; functions: FuncInfo[] };

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

export type CheckOutput = {
  version: number;
  engine: 'go-types' | 'go-syntax';
  engineVersion: string;
  degraded: boolean;
  steps: Record<string, { anchor?: Anchor; marks: Mark[]; callSites: CallSite[] }>;
  /** Links by flow id. */
  links: Record<string, Link[]>;
  problems: string[];
};
