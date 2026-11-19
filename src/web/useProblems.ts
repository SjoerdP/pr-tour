import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProblemMark, ProblemsResponse } from '../shared/api.js';
import {
  botLevel,
  botName,
  botTitle,
  mergeProblems,
  placeProblems,
  sortProblems,
  type Problem,
} from '../shared/problems.js';
import type { ReviewThread } from '../shared/review.js';
import type { Tour } from '../shared/tour.js';
import { getProblems, setProblemMark } from './api.js';
import { errorText } from './errors.js';
import type { ProblemsValue } from './ProblemsContext.js';

/** How often CI results are read again while CI runs. */
const PENDING_POLL_MS = 60_000;

/** An open bot thread as a possible problem; resolved and outdated threads are none. */
function botProblem(thread: ReviewThread): Problem | null {
  const first = thread.comments[0];
  if (!thread.bot || thread.resolved || thread.outdated || !first) return null;
  const source = botName(first.author);
  return {
    key: `bot|${thread.id}`,
    level: botLevel(first.author, first.body),
    title: botTitle(first.body) || `Comment by ${source}`,
    sources: [source],
    at:
      thread.side !== null && thread.line !== null
        ? { kind: 'line', file: thread.path, side: thread.side, line: thread.line }
        : { kind: 'file', file: thread.path },
    url: first.url,
    threadId: thread.id,
  };
}

/**
 * The tour's possible problems: CI's, read from the server for the tour's head commit, and
 * the open review threads of bots. Read again every minute while CI runs.
 *
 * `setMark` shows the mark at once and saves it in the background. If saving fails the
 * mark is taken back and `error` says so, next to the marks of problem `errorKey`.
 */
export function useProblems(
  repo: string,
  pr: number,
  tour: Tour | null,
  threads: ReviewThread[],
): ProblemsValue {
  // A rebuild is a new tour: its CI results are read again.
  const tourKey = tour ? `${tour.headSha} ${tour.createdAt}` : null;
  const [read, setRead] = useState<{
    key: string;
    answer: ProblemsResponse | null;
    failed: string | null;
  } | null>(null);
  const [round, setRound] = useState(0);
  // Marks set here that the server may not have sent back yet; null: taken away.
  const [local, setLocal] = useState<Record<string, ProblemMark | null>>({});
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null);

  useEffect(() => {
    if (tourKey === null) return;
    let live = true;
    getProblems(repo, pr).then(
      (answer) => {
        if (live) setRead({ key: tourKey, answer, failed: null });
      },
      (err: unknown) => {
        if (live) setRead({ key: tourKey, answer: null, failed: errorText(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [repo, pr, tourKey, round]);

  const current = read !== null && read.key === tourKey ? read : null;
  const answer = current?.answer ?? null;
  const pending = answer?.pending ?? false;

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setRound((r) => r + 1), PENDING_POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, answer]);

  const problems = useMemo(() => {
    if (!tour) return [];
    const bot = threads.map(botProblem).filter((p): p is Problem => p !== null);
    const ci = answer?.problems ?? [];
    return sortProblems(tour, placeProblems(tour, mergeProblems([...ci, ...bot])));
  }, [tour, threads, answer]);

  const markOf = useCallback(
    (key: string): ProblemMark | undefined =>
      key in local ? (local[key] ?? undefined) : answer?.marks[key],
    [local, answer],
  );

  const setMark = useCallback(
    (key: string, mark: ProblemMark | null) => {
      const before = markOf(key) ?? null;
      setLocal((prev) => ({ ...prev, [key]: mark }));
      setProblemMark(repo, pr, key, mark).then(
        () => setFailure(null),
        (err: unknown) => {
          setLocal((prev) => ({ ...prev, [key]: before }));
          setFailure({ key, text: `Could not save the mark: ${errorText(err)}` });
        },
      );
    },
    [repo, pr, markOf],
  );

  const loading = tourKey !== null && current === null;
  const outdated = answer?.outdated ?? false;
  const note =
    current?.failed != null
      ? `Could not read possible problems: ${current.failed}`
      : (answer?.error ?? null);
  const error = failure?.text ?? null;
  const errorKey = failure?.key ?? null;
  // One value while nothing changed, so the views that read it do not render again.
  return useMemo(
    () => ({ problems, markOf, setMark, loading, pending, outdated, note, error, errorKey }),
    [problems, markOf, setMark, loading, pending, outdated, note, error, errorKey],
  );
}
