import { useState, type ReactNode } from 'react';
import type { PlacedProblem } from '../../src/shared/problems.js';
import {
  EMPTY_PROBLEMS,
  ProblemsContext,
  type ProblemsValue,
} from '../../src/web/ProblemsContext.js';

/** Gives the views these problems; marks set by their buttons are kept, as the hook does. */
export function WithProblems({
  value,
  children,
}: {
  value: Partial<ProblemsValue>;
  children: ReactNode;
}) {
  const [marks, setMarks] = useState<Record<string, 'real' | 'not'>>({});
  const given = { ...EMPTY_PROBLEMS, ...value };
  return (
    <ProblemsContext.Provider
      value={{
        ...given,
        markOf: (key) => marks[key] ?? given.markOf(key),
        setMark: (key, mark) => {
          given.setMark(key, mark);
          setMarks((prev) => {
            const next = { ...prev };
            if (mark === null) delete next[key];
            else next[key] = mark;
            return next;
          });
        },
      }}
    >
      {children}
    </ProblemsContext.Provider>
  );
}

export function problem(
  key: string,
  level: PlacedProblem['level'],
  at: PlacedProblem['at'],
  homeId: string | null,
  more: Partial<PlacedProblem> = {},
): PlacedProblem {
  return { key, level, title: `Title ${key}`, sources: ['CodeRabbit'], at, homeId, ...more };
}

/** A problem's place on a head-side line. */
export const line = (file: string, n: number) => ({
  kind: 'line' as const,
  file,
  side: 'new' as const,
  line: n,
});
