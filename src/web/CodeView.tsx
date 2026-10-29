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
import type { CallRef, CallSite, Tour } from '../shared/tour.js';
import {
  callMatches,
  draftRows,
  focusRows,
  rowOf,
  rowOwners,
  siteMatches,
  threadRows,
  type CallMatch,
  type Focus,
  type Owner,
  type Reveal,
} from './code-lines.js';
import { FileComments, ReviewRow } from './CodeReview.js';
import { Composer } from './Composer.js';
import { useComposerMemory, type Selection } from './composer-memory.js';
import type { HighlightedLine, Token } from './highlight.js';
import { homesInOrder } from './homes.js';
import { withKey } from './shortcuts.js';
import { useCodeFile, type CodeFile, type Tokens } from './useCodeFile.js';
import { useKeys } from './useKeys.js';
import type { ReviewState } from './useReview.js';

export type JumpFn = (file: string, line: number, toStep?: string | null) => void;

export type CodeViewProps = {
  repo: string;
  pr: number;
  tour: Tour;
  file: string;
  focus: Focus | null;
  homeId: string;
  /** A place to scroll to and flash once (a jump from the review panel). */
  reveal?: Reveal | null;
  /** Show the code without syntax colours (generated code: skimmed, and often huge). */
  plain?: boolean;
  /**
   * Follow a traced call: show `file` around `line`. `toStep` comes from a call site of the
   * code check: a step id to go to, or null for a callee that is no step (look only).
   */
  onJump: JumpFn;
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
  reveal = null,
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
        reveal={reveal}
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
  reveal: Reveal | null;
  onJump: JumpFn;
  onOpenHome: (homeId: string) => void;
  review: ReviewState;
};

function threadsOn(threads: ReviewThread[], path: string): ReviewThread[] {
  return threads.filter((t) => t.path === path);
}

function draftsOn(drafts: Draft[], path: string): DraftComment[] {
  return drafts.filter((d): d is DraftComment => d.kind === 'comment' && d.path === path);
}

function FileCode({
  tour,
  file,
  tokens,
  focus,
  homeId,
  reveal,
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
  const sites = useMemo(() => stepSites(tour, homeId, file.path), [tour, homeId, file.path]);
  const siteTitle = useMemo(() => siteTitler(tour, homeId), [tour, homeId]);
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
  // What was being written on this file comes back when it shows again (see ComposerMemory).
  const memory = useComposerMemory();
  const memoryKey = `${tour.headSha}:${file.path}`;
  const [selection, setSelection] = useState<Selection | null>(
    () => memory?.file(memoryKey)?.selection ?? null,
  );
  const picked = selection && {
    side: selection.side,
    start: Math.min(selection.anchor, selection.line),
    end: Math.max(selection.anchor, selection.line),
  };
  // The composer remounts when it moves to another row; its text lives here meanwhile. A
  // ref, not state: typing must not re-render every row of the file.
  const typed = useRef(memory?.file(memoryKey)?.typed ?? '');
  // The memory follows the picked lines; typing updates it in `onType`.
  useEffect(() => {
    memory?.setFile(memoryKey, selection ? { selection, typed: typed.current } : null);
  }, [memory, memoryKey, selection]);
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

  // A drag over line numbers, like GitHub: the range shows while the button is down, and
  // becomes the selection (opening the composer) only on release, so nothing moves under
  // the pointer while picking. A press and release on one line is a plain click.
  const [drag, setDragState] = useState<Selection | null>(null);
  // The latest drag for the document listeners, which subscribe once per drag.
  const dragNow = useRef<Selection | null>(null);
  function setDrag(next: Selection | null) {
    dragNow.current = next;
    setDragState(next);
  }
  const lineDrag: LineDrag = {
    start: (side, line) => setDrag({ side, anchor: line, line }),
    over: (side, line, held) => {
      const d = dragNow.current;
      if (!d) return;
      // No button down: the release was missed (outside the window, a context menu).
      if (!held) setDrag(null);
      // Over the other side's numbers the range stays as it was.
      else if (d.side === side && d.line !== line) setDrag({ ...d, line });
    },
  };
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    // On the document: the button may be released anywhere, even off the numbers. A press
    // that slid off its one line and was let go elsewhere picks nothing.
    function onUp(event: globalThis.MouseEvent) {
      const d = dragNow.current;
      const onNumber =
        event.target instanceof Element && event.target.closest('.code-no-button') !== null;
      if (d && (d.anchor !== d.line || onNumber)) setSelection(d);
      setDrag(null);
    }
    function cancel() {
      setDrag(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // Esc ends only the drag here, not also a jump the tour would go back from.
      event.stopPropagation();
      cancel();
    }
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', cancel);
    };
  }, [dragging]);
  // What the rows show as picked: the drag while it lasts, else the selection.
  const marked = drag ?? selection;
  const markedRange = marked && {
    side: marked.side,
    start: Math.min(marked.anchor, marked.line),
    end: Math.max(marked.anchor, marked.line),
  };

  // The row a jump from the review panel asked for: -1 for the comments on the file, null
  // when the jump is not about this file.
  const revealRow = useMemo((): number | null => {
    if (!reveal) return null;
    if (reveal.at === 'focus') return focusRange?.[0] ?? null;
    const { path, side, line } = reveal.at;
    if (path !== file.path) return null;
    return side === null || line === null ? -1 : rowOf(rows, side, line);
  }, [reveal, focusRange, file.path, rows]);

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
    // The row a jump asked for opens, like a thread's.
    if (revealRow !== null && revealRow >= 0) keep.push([revealRow, revealRow]);
    return foldRows(rows, focusRange ? [focusRange, ...keep] : keep);
  }, [rows, whole, focusRange, opened, reviewRows, pickedRows, revealRow]);

  // The row to bring into view after the next render: the focus on mount, then each change
  // moved to.
  const scrollTo = useRef<number | null>(focusRange?.[0] ?? blocks[current]?.from ?? null);
  const container = useRef<HTMLDivElement>(null);
  // The last jump shown, so each one scrolls and flashes once.
  const revealed = useRef<number | null>(null);
  const flashed = useRef<{ el: Element; timer: number } | null>(null);
  useEffect(() => {
    if (reveal && revealRow !== null && reveal.seq !== revealed.current) {
      revealed.current = reveal.seq;
      scrollTo.current = null;
      const el = container.current?.querySelector(
        revealRow < 0 ? '.file-comments' : `[data-row="${revealRow}"]`,
      );
      if (el) {
        el.scrollIntoView?.({ block: 'center' });
        flashed.current = flash(el, flashed.current);
      }
      return;
    }
    if (scrollTo.current === null) return;
    const el = container.current?.querySelector(`[data-row="${scrollTo.current}"]`);
    // jsdom has no scrollIntoView.
    el?.scrollIntoView?.({ block: 'center' });
    scrollTo.current = null;
  });

  // A flash still running when the view goes away is stopped with it.
  useEffect(
    () => () => {
      if (flashed.current) window.clearTimeout(flashed.current.timer);
    },
    [],
  );

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
          if (selection) memory?.setFile(memoryKey, { selection, typed: body });
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
      <div className={drag ? 'code code-dragging' : 'code'} ref={container} style={gutter}>
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
              const no = markedRange?.side === 'new' ? row.newNo : row.oldNo;
              const selected =
                markedRange !== null &&
                no !== undefined &&
                no >= markedRange.start &&
                no <= markedRange.end;
              return (
                <Fragment key={i}>
                  <CodeRow
                    index={i}
                    row={row}
                    tokens={rowTokens(row, tokens)}
                    inFocus={inFocus}
                    focusFirst={i === focusRange?.[0]}
                    focusLast={i === focusRange?.[1]}
                    selected={selected}
                    showOld={showOld}
                    calls={inFocus && row.newNo !== undefined ? calls : NO_CALLS}
                    sites={inFocus && row.newNo !== undefined ? sites : undefined}
                    siteTitle={siteTitle}
                    label={label}
                    onPick={diff ? pick : null}
                    drag={lineDrag}
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

/** How long a revealed row stays marked: as long as its fade in the stylesheet. */
const FLASH_MS = 1600;

/**
 * Marks `el` with `reveal-flash` for a moment (the stylesheet fades it out), and takes the
 * mark off the one flashed before. Set on the element directly: React does not own this
 * class, and a re-render that changes the row's classes simply ends the flash early.
 */
function flash(
  el: Element,
  before: { el: Element; timer: number } | null,
): { el: Element; timer: number } {
  if (before) {
    window.clearTimeout(before.timer);
    before.el.classList.remove('reveal-flash');
  }
  // Reading the layout between removing and adding the class restarts the animation.
  void (el as HTMLElement).offsetWidth;
  el.classList.add('reveal-flash');
  const timer = window.setTimeout(() => el.classList.remove('reveal-flash'), FLASH_MS);
  return { el, timer };
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

/** The call sites the code check found in `homeId`, when it is a checked step in `path`. */
function stepSites(tour: Tour, homeId: string, path: string): CallSite[] | undefined {
  const home = homesInOrder(tour).find((h) => h.id === homeId);
  return home?.kind === 'step' && home.step.file === path ? home.step.callSites : undefined;
}

/** The button title of a call site: "Go to step 3" in the same flow, else "Show <name>". */
function siteTitler(tour: Tour, homeId: string): (site: CallSite) => string {
  const home = homesInOrder(tour).find((h) => h.id === homeId);
  return (site) => {
    if (site.toStep !== undefined) {
      const no =
        home?.kind === 'step' ? home.flow.steps.findIndex((s) => s.id === site.toStep) : -1;
      if (no >= 0) return `Go to step ${no + 1}`;
      const target = tour.flows.flatMap((f) => f.steps).find((s) => s.id === site.toStep);
      const name = target?.anchor?.name ?? target?.title;
      if (name) return `Show ${name}`;
    }
    return 'Show the called function';
  };
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
  /** The first and last rows of the focus, which close its frame. */
  focusFirst: boolean;
  focusLast: boolean;
  /** Picked for a comment. */
  selected: boolean;
  /** False when the file has no old side (an added file). */
  showOld: boolean;
  calls: CallRef[];
  /** The step's call sites, when the code check found them: they replace `calls`. `[]` means checked, no calls: name matching is not used. */
  sites: CallSite[] | undefined;
  siteTitle: (site: CallSite) => string;
  label: Owner | null;
  /** Picks a line for a comment (`extend` on shift+click); null when comments are not possible. */
  onPick: ((side: DiffSide, line: number, extend: boolean) => void) | null;
  drag: LineDrag;
  onJump: JumpFn;
  onOpenHome: (homeId: string) => void;
};

/** A drag over line numbers: pressed on a line, then moved over others. */
type LineDrag = {
  start: (side: DiffSide, line: number) => void;
  /** `held`: the primary button is still down. */
  over: (side: DiffSide, line: number, held: boolean) => void;
};

/**
 * A line number; a button that picks the line for a comment when `onPick` is given. A click
 * (or Enter/Space) picks it, shift+click extends the selection, and a press dragged over
 * other numbers picks the range.
 */
function LineNo({
  no,
  side,
  onPick,
  drag,
}: {
  no: number | undefined;
  side: DiffSide;
  onPick: CodeRowProps['onPick'];
  drag: LineDrag;
}) {
  if (no === undefined || !onPick) return <span className="code-no">{no ?? ''}</span>;
  const label = side === 'new' ? `Comment on line ${no}` : `Comment on old line ${no}`;
  return (
    <button
      type="button"
      className="code-no code-no-button"
      aria-label={label}
      title={`${label} (drag or Shift+click to select a range)`}
      onMouseDown={(event: MouseEvent) => {
        // Shift+click extends in onClick; other buttons do not pick.
        if (event.button === 0 && !event.shiftKey) drag.start(side, no);
      }}
      onMouseEnter={(event: MouseEvent) => drag.over(side, no, (event.buttons & 1) === 1)}
      // After a drag released on this same line, this picks that line again: no change.
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
  focusFirst,
  focusLast,
  selected,
  showOld,
  calls,
  sites,
  siteTitle,
  label,
  onPick,
  drag,
  onJump,
  onOpenHome,
}: CodeRowProps) {
  // Tokens that do not spell the row's text (a stale highlight) are not trusted.
  const parts =
    tokens && tokens.map((t) => t.content).join('') === row.text ? tokens : [{ content: row.text }];
  const matches = sites
    ? siteMatches(row, sites)
    : calls.length > 0
      ? callMatches(row.text, calls)
      : [];
  const focus = inFocus
    ? ` code-focus${focusFirst ? ' code-focus-first' : ''}${focusLast ? ' code-focus-last' : ''}`
    : '';
  return (
    <div
      className={`code-row code-${row.kind}${focus}${selected ? ' code-selected' : ''}`}
      data-row={index}
    >
      {/* Deleted lines are commented on the old side, all others on the new side. */}
      {showOld && (
        <LineNo no={row.oldNo} side="old" onPick={row.kind === 'del' ? onPick : null} drag={drag} />
      )}
      <LineNo no={row.newNo} side="new" onPick={onPick} drag={drag} />
      <span className="code-marker">{MARKERS[row.kind]}</span>
      <code className="code-text">
        {lineContent(parts, row.text.length, matches, onJump, siteTitle)}
      </code>
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
  onJump: JumpFn,
  siteTitle: (site: CallSite) => string,
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
        title={m.site ? siteTitle(m.site) : `${m.call.file}:${m.call.line}`}
        onClick={() =>
          m.site
            ? onJump(m.call.file, m.call.line, m.site.toStep ?? null)
            : onJump(m.call.file, m.call.line)
        }
      >
        {spans(slice(tokens, m.from, m.to), 'c')}
      </button>,
    );
    pos = m.to;
  });
  out.push(...spans(slice(tokens, pos, length), 'end-'));
  return out;
}
