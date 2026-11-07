import { createContext, useContext } from 'react';
import type { ProblemMark } from '../shared/api.js';
import type { PlacedProblem } from '../shared/problems.js';

/** The tour's possible problems and the reader's marks on them, for every view that shows them. */
export type ProblemsValue = {
  /** Worst first, then tour order. */
  problems: PlacedProblem[];
  markOf: (key: string) => ProblemMark | undefined;
  /** Shows the mark at once and saves it; `null` takes the mark away. */
  setMark: (key: string, mark: ProblemMark | null) => void;
  /** The first read of CI results is under way. */
  loading: boolean;
  /** CI is still running on the tour's head commit. */
  pending: boolean;
  /** The PR has newer commits; their CI results are not shown. */
  outdated: boolean;
  /** Why CI or the diff could not be read, as a muted note; null when all went well. */
  note: string | null;
  /** Why the last mark was not saved. */
  error: string | null;
};

/** No problems and nothing loading: what views see outside a tour. */
export const EMPTY_PROBLEMS: ProblemsValue = {
  problems: [],
  markOf: () => undefined,
  setMark: () => {},
  loading: false,
  pending: false,
  outdated: false,
  note: null,
  error: null,
};

export const ProblemsContext = createContext<ProblemsValue>(EMPTY_PROBLEMS);

export function useProblemsContext(): ProblemsValue {
  return useContext(ProblemsContext);
}
