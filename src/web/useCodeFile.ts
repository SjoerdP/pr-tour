import { useEffect, useState } from 'react';
import type { FileDiff } from '../shared/diff.js';
import type { Tour } from '../shared/tour.js';
import { ApiError, getDiff, getFile } from './api.js';
import { highlight, type HighlightedLine } from './highlight.js';

/** A file of the tour, both sides. An unchanged file (a followed call) has `diff: null`. */
export type CodeFile = {
  path: string;
  oldPath: string;
  diff: FileDiff | null;
  /** Head text; null when the PR deletes the file. */
  newText: string | null;
  /** Base (merge base) text; null when the PR adds the file. */
  oldText: string | null;
};

export type CodeFileLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'binary' }
  | { status: 'ready'; file: CodeFile };

/** Head and base tokens, null until Shiki is done (the code is shown plain meanwhile). */
export type Tokens = { head: HighlightedLine[] | null; base: HighlightedLine[] | null };

const NO_TOKENS: Tokens = { head: null, base: null };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadFile(repo: string, pr: number, tour: Tour, file: string): Promise<CodeFileLoad> {
  let diff: FileDiff | null;
  try {
    diff = await getDiff(repo, pr, file);
  } catch (err) {
    // 404: the PR does not change this file (a traced call can point anywhere).
    if (!(err instanceof ApiError && err.status === 404)) throw err;
    diff = null;
  }
  if (diff?.binary) return { status: 'binary' };

  if (!diff) {
    const { text } = await getFile(repo, pr, tour.headSha, file);
    if (text === null) return { status: 'error', message: `${file} does not exist in this PR` };
    return {
      status: 'ready',
      file: { path: file, oldPath: file, diff: null, newText: text, oldText: text },
    };
  }

  // Renamed files: the base text lives at the old path.
  const [head, base] = await Promise.all([
    diff.status === 'deleted' ? null : getFile(repo, pr, tour.headSha, diff.path),
    diff.status === 'added' ? null : getFile(repo, pr, tour.baseSha, diff.oldPath),
  ]);
  return {
    status: 'ready',
    file: {
      path: diff.path,
      oldPath: diff.oldPath,
      diff,
      newText: head?.text ?? null,
      oldText: base?.text ?? null,
    },
  };
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * Loads `file` at the tour's base and head, then highlights both sides in the background
 * (unless `plain`).
 */
export function useCodeFile(
  repo: string,
  pr: number,
  tour: Tour,
  file: string,
  plain = false,
): { load: CodeFileLoad; tokens: Tokens } {
  const [state, setState] = useState<{ key: string; load: CodeFileLoad; tokens: Tokens }>({
    key: '',
    load: { status: 'loading' },
    tokens: NO_TOKENS,
  });
  const key = `${repo}#${pr}@${tour.baseSha}..${tour.headSha}:${file}${plain ? ':plain' : ''}`;

  useEffect(() => {
    let cancelled = false;
    const update = (load: CodeFileLoad, tokens: Tokens = NO_TOKENS) => {
      if (!cancelled) setState({ key, load, tokens });
    };

    loadFile(repo, pr, tour, file).then(
      (load) => {
        update(load);
        if (load.status !== 'ready' || plain) return;
        const { path, oldPath, newText, oldText } = load.file;
        const theme = prefersDark() ? 'dark' : 'light';
        const head = newText === null ? null : highlight(newText, path, theme);
        const base =
          oldText === null ? null : oldText === newText ? head : highlight(oldText, oldPath, theme);
        // highlight() never rejects: it falls back to plain text.
        void Promise.all([head, base]).then(([h, b]) => update(load, { head: h, base: b }));
      },
      (err: unknown) => update({ status: 'error', message: message(err) }),
    );
    return () => {
      cancelled = true;
    };
    // The tour object changes on every refetch; only its commits matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Until the new file arrives, show loading rather than the previous file.
  return state.key === key ? state : { load: { status: 'loading' }, tokens: NO_TOKENS };
}
