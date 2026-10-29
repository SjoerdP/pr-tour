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

/** The code range a step is pinned to. */
export type Anchor = {
  name: string;
  startLine: number;
  endLine: number;
  source: 'symbol' | 'incoming-link' | 'range';
};
/** A side effect found on a line, from the code, from Claude, or both. */
export type Mark = {
  line: number;
  kind: 'db-write' | 'event' | 'external-call' | 'async';
  label?: string;
  source: 'code' | 'claude' | 'both';
};
/** A call in a step, with the column range of the callee name. */
export type CallSite = {
  line: number;
  col: number;
  endCol: number;
  to: { file: string; line: number };
  toStep?: string;
};
/** A link between two steps and how well the code backs it up. */
export type Link = {
  from: string;
  to: string;
  line: number;
  how: 'call' | 'register' | 'service' | 'event';
  via?: string[];
  source: 'claude' | 'code' | 'both';
  check: 'proven' | 'name-match' | 'not-found' | 'conflict' | 'unchecked';
  note?: string;
  reason?: string;
};
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
