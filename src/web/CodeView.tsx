import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { FileDiff } from '../shared/diff.js';
import {
  commentTarget,
  type DiffSide,
  type Draft,
  type DraftComment,
  type ReviewThread,
} from '../shared/review.js';
import { buildRows, changeBlocks, foldRows, type Row, type Segment } from '../shared/rows.js';
import type { CallRef, Tour } from '../shared/tour.js';
import {
  callMatches,
  draftRows,
  focusRows,
  rowOf,
  rowOwners,
  threadRows,
  type CallMatch,
  type Focus,
  type Owner,
} from './code-lines.js';
import { FileComments, ReviewRow } from './CodeReview.js';
import { Composer } from './Composer.js';
import type { HighlightedLine, Token } from './highlight.js';
import { homesInOrder } from './homes.js';
import { withKey } from './shortcuts.js';
import { useCodeFile, type CodeFile, type Tokens } from './useCodeFile.js';
import { useKeys } from './useKeys.js';
import type { ReviewState } from './useReview.js';

export type CodeViewProps = {
  repo: string;
  pr: number;
  tour: Tour;
  file: string;
  focus: Focus | null;
  homeId: string;
  /** Show the code without syntax colours (generated code: skimmed, and often huge). */
  plain?: boolean;
  /** Follow a traced call: show `file` around `line`. */
  onJump: (file: string, line: number) => void;
  /** Open another home of the tour (from a "belongs to" label). */
  onOpenHome: (homeId: string) => void;
  /** The PR's review: threads and drafts are shown in place, new comments go here. */
  review: ReviewState;
};

/** The whole file of a home: changes and the focus open, unchanged code folded. */
export function CodeView({
  repo,
  pr,
  tour,
  file,
  focus,
  homeId,
  plain = false,
  onJump,
  onOpenHome,
  review,
}: CodeViewProps) {
  const { load, tokens } = useCodeFile(repo, pr, tour, file, plain);

  let body: ReactNode;
  if (load.status === 'loading') body = <p className="muted">Loading {file}…</p>;
  else if (load.status === 'error') {
    body = (
      <p className="error" role="alert">
        Could not load {file}: {load.message}
      </p>
    );
  } else if (load.status === 'binary') {
    // No lines to sit at: every thread and draft goes to the block above.
    body = (
      <>
        <FileComments
          path={file}
          headSha={tour.headSha}
          threads={threadsOn(review.threads, file)}
          drafts={draftsOn(review.drafts, file)}
          review={review}
        />
        <p className="muted">Binary file changed</p>
      </>
    );
  } else {
    body = (
      <FileCode
        // New file or new focus: start over with folds closed and the first change.
        key={`${file}:${focus?.side ?? 'new'}:${focus?.start}-${focus?.end}`}
        tour={tour}
        file={load.file}
        tokens={tokens}
        focus={focus}
        homeId={homeId}
        onJump={onJump}
        onOpenHome={onOpenHome}
        review={review}
      />
    );
  }

  return (
    <section className="code-view" aria-label="Code">
      {body}
    </section>
  );
}

type FileCodeProps = {
  tour: Tour;
  file: CodeFile;
  tokens: Tokens;
  focus: Focus | null;
  homeId: string;
  onJump: (file: string, line: number) => void;
  onOpenHome: (homeId: string) => void;
  review: ReviewState;
};

function threadsOn(threads: ReviewThread[], path: string): ReviewThread[] {
  return threads.filter((t) => t.path === path);
}

function draftsOn(drafts: Draft[], path: string): DraftComment[] {
  return drafts.filter((d): d is DraftComment => d.kind === 'comment' && d.path === path);
}

/** Lines picked for a comment: from the first one clicked to the last one (shift+)clicked. */
type Selection = { side: DiffSide; anchor: number; line: number };

function FileCode({
  tour,
  file,
  tokens,
  focus,
  homeId,
  onJump,
  onOpenHome,
  review,
}: FileCodeProps) {
  const rows = useMemo(() => buildRows(file.newText, file.oldText, file.diff?.hunks ?? []), [file]);
  const blocks = useMemo(() => changeBlocks(rows), [rows]);
  const focusRange = useMemo(() => focusRows(rows, focus), [rows, focus]);
  const owners = useMemo(
    () => rowOwners(tour, rows, file.path, file.oldPath),
    [tour, rows, file.path, file.oldPath],
  );
  const calls = useMemo(() => stepCalls(tour, homeId, file.path), [tour, homeId, file.path]);
  // An added file has no old side: no empty column for old line numbers.
  const showOld = useMemo(() => rows.some((r) => r.oldNo !== undefined), [rows]);
  // Line-number columns as wide as the longest number.
  const gutter = useMemo(() => {
    const widest = rows.reduce((n, r) => Math.max(n, r.oldNo ?? 0, r.newNo ?? 0), 0);
    return { '--no-width': `${Math.max(2, String(widest).length)}ch` } as CSSProperties;
  }, [rows]);

  const { threads, drafts } = review;
  const threadsAt = useMemo(
    () => threadRows(rows, threadsOn(threads, file.path)),
    [rows, threads, file.path],
  );
  const draftsAt = useMemo(
    () => draftRows(rows, draftsOn(drafts, file.path), tour.headSha),
    [rows, drafts, file.path, tour.headSha],
  );
  // Rows with a thread or a draft stay open, like changes.
  const reviewRows = useMemo(() => {
    const at = new Set([...threadsAt.keys(), ...draftsAt.keys()]);
    at.delete(-1);
    return [...at].map((i): [number, number] => [i, i]);
  }, [threadsAt, draftsAt]);

  // GitHub takes comments only on files the PR changes.
  const diff = file.diff;
  const [selection, setSelection] = useState<Selection | null>(null);
  const picked = selection && {
    side: selection.side,
    start: Math.min(selection.anchor, selection.line),
    end: Math.max(selection.anchor, selection.line),
  };
  // The composer remounts when it moves to another row; its text lives here meanwhile. A
  // ref, not state: typing must not re-render every row of the file.
  const typed = useRef('');
  function clearSelection() {
    setSelection(null);
    typed.current = '';
  }
  // The picked rows, where the composer sits, stay open (folding them would drop its text).
  const pickedRows = useMemo((): Array<[number, number]> => {
    if (!selection) return [];
    const { side, anchor, line } = selection;
    const a = rowOf(rows, side, Math.min(anchor, line));
    const b = rowOf(rows, side, Math.max(anchor, line));
    return a < 0 || b < 0 ? [] : [[a, b]];
  }, [rows, selection]);

  function pick(side: DiffSide, line: number, extend: boolean) {
    setSelection((s) =>
      extend && s?.side === side ? { ...s, line } : { side, anchor: line, line },
    );
  }

  const [opened, setOpened] = useState<Array<[number, number]>>([]);
  const [whole, setWhole] = useState(false);
  // Start on the first change at or after the focus (the last one if the focus is below all).
  const [current, setCurrent] = useState(() => {
    if (!focusRange) return 0;
    const i = blocks.findIndex((b) => b.to >= focusRange[0]);
    return i < 0 ? Math.max(0, blocks.length - 1) : i;
  });
  const segments: Segment[] = useMemo(() => {
    if (whole) return rows.length === 0 ? [] : [{ kind: 'rows', from: 0, to: rows.length - 1 }];
    const keep = [...opened, ...reviewRows, ...pickedRows];
    return foldRows(rows, focusRange ? [focusRange, ...keep] : keep);
  }, [rows, whole, focusRange, opened, reviewRows, pickedRows]);

  // The row to bring into view after the next render: the focus on mount, then each change
  // moved to.
  const scrollTo = useRef<number | null>(focusRange?.[0] ?? blocks[current]?.from ?? null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollTo.current === null) return;
    const el = container.current?.querySelector(`[data-row="${scrollTo.current}"]`);
    // jsdom has no scrollIntoView.
    el?.scrollIntoView?.({ block: 'center' });
    scrollTo.current = null;
  });

  function goToChange(i: number) {
    const block = blocks[i];
    if (!block) return;
    setCurrent(i);
    // Changes are never folded today, but a block that is must open when we move to it.
    setOpened((o) => [...o, [block.from, block.to]]);
    scrollTo.current = block.from;
  }

  useKeys({
    n: () => goToChange(current + 1),
    p: () => goToChange(current - 1),
    f: () => setWhole((w) => !w),
  });

  let composerRow = -1;
  let composer: ReactNode = null;
  if (diff && picked) {
    composerRow = rowOf(rows, picked.side, picked.end);
    composer = (
      <PickedComposer
        diff={diff}
        rows={rows}
        picked={picked}
        onSubmit={async (body) => {
          await review.add({
            kind: 'comment',
            path: file.path,
            side: picked.side,
            startLine: picked.start,
            endLine: picked.end,
            // The lines were picked on this tour; the server refuses them on another one.
            headSha: tour.headSha,
            body,
          });
          clearSelection();
        }}
        onCancel={clearSelection}
        restore={() => typed.current}
        onType={(body) => {
          typed.current = body;
        }}
      />
    );
  }

  const status = file.diff?.status;
  return (
    <>
      <div className="code-toolbar">
        <code className="code-path" title={file.path}>
          {file.path}
        </code>
        {status === 'renamed' && <span className="muted">renamed from {file.oldPath}</span>}
        {status === 'added' && <span className="muted">new file</span>}
        {status === 'deleted' && <span className="muted">deleted file</span>}
        <span className="code-counter muted">
          {blocks.length === 0
            ? 'no changes in this file'
            : `change ${current + 1} of ${blocks.length}`}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Previous change"
          onClick={() => goToChange(current - 1)}
          disabled={current <= 0}
          title={withKey('Previous change', 'p')}
        >
          ↑
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Next change"
          onClick={() => goToChange(current + 1)}
          disabled={current >= blocks.length - 1}
          title={withKey('Next change', 'n')}
        >
          ↓
        </button>
        <button
          type="button"
          aria-pressed={whole}
          onClick={() => setWhole((w) => !w)}
          title={withKey('Whole file', 'f')}
        >
          Whole file
        </button>
      </div>
      <div className="code" ref={container} style={gutter}>
        <FileComments
          path={file.path}
          headSha={tour.headSha}
          threads={threadsAt.get(-1) ?? NO_THREADS}
          drafts={draftsAt.get(-1) ?? NO_DRAFTS}
          review={review}
        />
        {segments.map((seg) =>
          seg.kind === 'fold' ? (
            <button
              key={`fold-${seg.from}`}
              type="button"
              className="fold-bar"
              onClick={() => setOpened((o) => [...o, [seg.from, seg.to]])}
            >
              ⋯ {seg.count} unchanged lines ⋯
            </button>
          ) : (
            rowRange(seg.from, seg.to).map((i) => {
              const row = rows[i]!;
              const owner = owners[i];
              // One label per run of rows owned by the same other home.
              const label =
                owner && owner.id !== homeId && owners[i - 1]?.id !== owner.id ? owner : null;
              const inFocus = focusRange !== null && i >= focusRange[0] && i <= focusRange[1];
              const rowThreads = threadsAt.get(i);
              const rowDrafts = draftsAt.get(i);
              const no = picked?.side === 'new' ? row.newNo : row.oldNo;
              const selected =
                picked !== null && no !== undefined && no >= picked.start && no <= picked.end;
              return (
                <Fragment key={i}>
                  <CodeRow
                    index={i}
                    row={row}
                    tokens={rowTokens(row, tokens)}
                    inFocus={inFocus}
                    selected={selected}
                    showOld={showOld}
                    calls={inFocus && row.newNo !== undefined ? calls : NO_CALLS}
                    label={label}
                    onPick={diff ? pick : null}
                    onJump={onJump}
                    onOpenHome={onOpenHome}
                  />
                  {(rowThreads || rowDrafts || composerRow === i) && (
                    <ReviewRow
                      path={file.path}
                      headSha={tour.headSha}
                      threads={rowThreads ?? NO_THREADS}
                      drafts={rowDrafts ?? NO_DRAFTS}
                      review={review}
                      composer={composerRow === i ? composer : null}
                    />
                  )}
                </Fragment>
              );
            })
          ),
        )}
      </div>
    </>
  );
}

const NO_CALLS: CallRef[] = [];
const NO_THREADS: ReviewThread[] = [];
const NO_DRAFTS: DraftComment[] = [];

type Picked = { side: DiffSide; start: number; end: number };

/**
 * The composer for the picked lines. It says before sending when they become a file-level
 * comment (outside the diff, or across hunks); new-side lines can start a suggestion.
 */
function PickedComposer({
  diff,
  rows,
  picked,
  onSubmit,
  onCancel,
  restore,
  onType,
}: {
  diff: FileDiff;
  rows: Row[];
  picked: Picked;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  /** The text typed before the composer last moved. */
  restore: () => string;
  onType: (body: string) => void;
}) {
  const { side, start, end } = picked;
  const lineText = (n: number) => rows[rowOf(rows, side, n)]?.text ?? '';
  const target = commentTarget(diff, side, start, end, lineText);
  const suggestFrom = side === 'new' ? rowRange(start, end).map(lineText) : null;
  return (
    <Composer
      target={target}
      path={diff.path}
      suggestFrom={suggestFrom}
      submitLabel="Add comment"
      restore={restore}
      onType={onType}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

function rowRange(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, k) => from + k);
}

/** The traced calls of `homeId` when it is a step in `path`; none otherwise. */
function stepCalls(tour: Tour, homeId: string, path: string): CallRef[] {
  const home = homesInOrder(tour).find((h) => h.id === homeId);
  return home?.kind === 'step' && home.step.file === path ? home.step.calls : NO_CALLS;
}

function rowTokens(row: Row, tokens: Tokens): HighlightedLine | undefined {
  if (row.kind === 'del') return row.oldNo === undefined ? undefined : tokens.base?.[row.oldNo - 1];
  return row.newNo === undefined ? undefined : tokens.head?.[row.newNo - 1];
}

const MARKERS = { add: '+', del: '-', ctx: ' ' } as const;

type CodeRowProps = {
  index: number;
  row: Row;
  tokens: HighlightedLine | undefined;
  inFocus: boolean;
  /** Picked for a comment. */
  selected: boolean;
  /** False when the file has no old side (an added file). */
  showOld: boolean;
  calls: CallRef[];
  label: Owner | null;
  /** Picks a line for a comment (`extend` on shift+click); null when comments are not possible. */
  onPick: ((side: DiffSide, line: number, extend: boolean) => void) | null;
  onJump: (file: string, line: number) => void;
  onOpenHome: (homeId: string) => void;
};

/** A line number; a button that picks the line for a comment when `onPick` is given. */
function LineNo({
  no,
  side,
  onPick,
}: {
  no: number | undefined;
  side: DiffSide;
  onPick: CodeRowProps['onPick'];
}) {
  if (no === undefined || !onPick) return <span className="code-no">{no ?? ''}</span>;
  const label = side === 'new' ? `Comment on line ${no}` : `Comment on old line ${no}`;
  return (
    <button
      type="button"
      className="code-no code-no-button"
      aria-label={label}
      title={`${label} (Shift+click to select a range)`}
      onClick={(event: MouseEvent) => onPick(side, no, event.shiftKey)}
    >
      {no}
    </button>
  );
}

function CodeRow({
  index,
  row,
  tokens,
  inFocus,
  selected,
  showOld,
  calls,
  label,
  onPick,
  onJump,
  onOpenHome,
}: CodeRowProps) {
  // Tokens that do not spell the row's text (a stale highlight) are not trusted.
  const parts =
    tokens && tokens.map((t) => t.content).join('') === row.text ? tokens : [{ content: row.text }];
  const matches = calls.length > 0 ? callMatches(row.text, calls) : [];
  return (
    <div
      className={`code-row code-${row.kind}${inFocus ? ' code-focus' : ''}${selected ? ' code-selected' : ''}`}
      data-row={index}
    >
      {/* Deleted lines are commented on the old side, all others on the new side. */}
      {showOld && <LineNo no={row.oldNo} side="old" onPick={row.kind === 'del' ? onPick : null} />}
      <LineNo no={row.newNo} side="new" onPick={onPick} />
      <span className="code-marker">{MARKERS[row.kind]}</span>
      <code className="code-text">{lineContent(parts, row.text.length, matches, onJump)}</code>
      {label && (
        <button type="button" className="owner-label" onClick={() => onOpenHome(label.id)}>
          belongs to {label.title}
        </button>
      )}
    </div>
  );
}

/** The tokens covering characters `[from, to)` of the line, cut at the edges. */
function slice(tokens: Token[], from: number, to: number): Token[] {
  const out: Token[] = [];
  let at = 0;
  for (const t of tokens) {
    const end = at + t.content.length;
    const a = Math.max(from, at);
    const b = Math.min(to, end);
    if (a < b) out.push({ content: t.content.slice(a - at, b - at), color: t.color });
    at = end;
  }
  return out;
}

function spans(tokens: Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((t, k) => (
    <span key={`${keyPrefix}${k}`} style={t.color ? { color: t.color } : undefined}>
      {t.content}
    </span>
  ));
}

/** The line's tokens, with each traced call wrapped in a button that follows it. */
function lineContent(
  tokens: Token[],
  length: number,
  matches: CallMatch[],
  onJump: (file: string, line: number) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  matches.forEach((m, k) => {
    out.push(...spans(slice(tokens, pos, m.from), `t${k}-`));
    out.push(
      <button
        key={`call${k}`}
        type="button"
        className="call-link"
        title={`${m.call.file}:${m.call.line}`}
        onClick={() => onJump(m.call.file, m.call.line)}
      >
        {spans(slice(tokens, m.from, m.to), 'c')}
      </button>,
    );
    pos = m.to;
  });
  out.push(...spans(slice(tokens, pos, length), 'end-'));
  return out;
}
