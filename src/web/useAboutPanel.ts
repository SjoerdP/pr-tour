import { useEffect, useState } from 'react';

function storageKey(repo: string, pr: number): string {
  return `pr-tour:about-seen:${repo}#${pr}`;
}

/** True when "About this PR" was shown for this PR before (in this browser). */
function shownBefore(repo: string, pr: number): boolean {
  try {
    return localStorage.getItem(storageKey(repo, pr)) !== null;
  } catch {
    // Storage blocked (private window, site data off): treat every visit as the first.
    return false;
  }
}

function rememberShown(repo: string, pr: number): void {
  try {
    localStorage.setItem(storageKey(repo, pr), '1');
  } catch {
    // Storage blocked: nothing to remember it in; the panel opens again next time.
  }
}

/**
 * Whether "About this PR" is open. It is open on the first visit to a tour (remembered per
 * PR in localStorage) until the user closes it or moves on. Only a visit that showed a tour
 * counts, so a first build still ends with the summary open.
 */
export function useAboutPanel(
  repo: string,
  pr: number,
  hasTour: boolean,
): { open: boolean; setOpen: (open: boolean) => void } {
  const [firstVisit] = useState(() => !shownBefore(repo, pr));
  // `null` until the user (or a move through the tour) decides; until then, the first visit.
  const [choice, setChoice] = useState<boolean | null>(null);

  useEffect(() => {
    if (hasTour) rememberShown(repo, pr);
  }, [hasTour, repo, pr]);

  return { open: hasTour && (choice ?? firstVisit), setOpen: setChoice };
}
