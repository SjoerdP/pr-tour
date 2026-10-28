import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildRows, changeBlocks, foldRows, type Row, type Segment } from '../shared/rows.js';
import type { CallRef, Tour } from '../shared/tour.js';
import {
  callMatches,
  focusRows,
  rowOwners,
  type CallMatch,
  type Focus,
  type Owner,
} from './code-lines.js';
import type { HighlightedLine, Token } from './highlight.js';
import { homesInOrder } from './homes.js';
import { withKey } from './shortcuts.js';
import { useCodeFile, type CodeFile, type Tokens } from './useCodeFile.js';
import { useKeys } from './useKeys.js';

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
  } else if (load.status === 'binary') body = <p className="muted">Binary file changed</p>;
  else {
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
};

function FileCode({ tour, file, tokens, focus, homeId, onJump, onOpenHome }: FileCodeProps) {
  const rows = useMemo(() => buildRows(file.newText, file.oldText, file.diff?.hunks ?? []), [file]);
  const blocks = useMemo(() => changeBlocks(rows), [rows]);
  const focusRange = useMemo(() => focusRows(rows, focus), [rows, focus]);
  const owners = useMemo(
    () => rowOwners(tour, rows, file.path, file.oldPath),
    [tour, rows, file.path, file.oldPath],
  );
  const calls = useMemo(() => stepCalls(tour, homeId, file.path), [tour, homeId, file.path]);

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
    return foldRows(rows, focusRange ? [focusRange, ...opened] : opened);
  }, [rows, whole, focusRange, opened]);

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

  const status = file.diff?.status;
  return (
    <>
      <div className="code-toolbar">
        <code className="code-path">{file.path}</code>
        {status === 'renamed' && <span className="muted">renamed from {file.oldPath}</span>}
        {status === 'added' && <span className="muted">new file</span>}
        {status === 'deleted' && <span className="muted">deleted file</span>}
        <span className="code-counter muted">
          {blocks.length === 0
            ? 'no changes in this file'
            : `change ${current + 1} of ${blocks.length} in this file`}
        </span>
        <button
          type="button"
          onClick={() => goToChange(current - 1)}
          disabled={current <= 0}
          title={withKey('Prev change', 'p')}
        >
          Prev change
        </button>
        <button
          type="button"
          onClick={() => goToChange(current + 1)}
          disabled={current >= blocks.length - 1}
          title={withKey('Next change', 'n')}
        >
          Next change
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
      <div className="code" ref={container}>
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
              return (
                <CodeRow
                  key={i}
                  index={i}
                  row={row}
                  tokens={rowTokens(row, tokens)}
                  inFocus={inFocus}
                  calls={inFocus && row.newNo !== undefined ? calls : NO_CALLS}
                  label={label}
                  onJump={onJump}
                  onOpenHome={onOpenHome}
                />
              );
            })
          ),
        )}
      </div>
    </>
  );
}

const NO_CALLS: CallRef[] = [];

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
  calls: CallRef[];
  label: Owner | null;
  onJump: (file: string, line: number) => void;
  onOpenHome: (homeId: string) => void;
};

function CodeRow({ index, row, tokens, inFocus, calls, label, onJump, onOpenHome }: CodeRowProps) {
  // Tokens that do not spell the row's text (a stale highlight) are not trusted.
  const parts =
    tokens && tokens.map((t) => t.content).join('') === row.text ? tokens : [{ content: row.text }];
  const matches = calls.length > 0 ? callMatches(row.text, calls) : [];
  return (
    <div className={`code-row code-${row.kind}${inFocus ? ' code-focus' : ''}`} data-row={index}>
      <span className="code-no">{row.oldNo ?? ''}</span>
      <span className="code-no">{row.newNo ?? ''}</span>
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
