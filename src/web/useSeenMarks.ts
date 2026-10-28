import { useState } from 'react';
import type { Tour } from '../shared/tour.js';
import { markSeen } from './api.js';
import { errorText } from './errors.js';

/**
 * Which homes the user has seen. A home counts as seen only when its mark has the home's
 * current content hash, so a home whose code changed since is unseen again.
 *
 * `markLeft` shows the mark at once and saves it in the background. If saving fails the
 * mark is taken back and `error` says so; reading goes on (steps are never a gate).
 */
export function useSeenMarks(
  repo: string,
  pr: number,
  tour: Tour | null,
  /** Marks as the server last sent them: `homeId → contentHash`. */
  serverSeen: Record<string, string>,
): {
  isSeen: (homeId: string) => boolean;
  markLeft: (homeId: string) => void;
  error: string | null;
} {
  // Marks made here that the server may not have sent back yet.
  const [local, setLocal] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  function isSeen(homeId: string): boolean {
    const hash = tour?.hashes[homeId];
    return hash !== undefined && (local[homeId] ?? serverSeen[homeId]) === hash;
  }

  function markLeft(homeId: string) {
    const hash = tour?.hashes[homeId];
    if (hash === undefined || isSeen(homeId)) return;
    setLocal((prev) => ({ ...prev, [homeId]: hash }));
    markSeen(repo, pr, homeId, hash).then(
      () => setError(null),
      (err: unknown) => {
        setLocal((prev) => {
          const rest = { ...prev };
          delete rest[homeId];
          return rest;
        });
        setError(`Could not save that you saw this step: ${errorText(err)}`);
      },
    );
  }

  return { isSeen, markLeft, error };
}
