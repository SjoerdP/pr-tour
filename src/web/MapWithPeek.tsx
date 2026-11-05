import {
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { Flow } from '../shared/tour.js';
import { FlowMap } from './FlowMap.js';
import { Peek } from './Peek.js';

/**
 * What is peeked at: a step of a flow, and maybe a calling line in it. `nonce` changes when the
 * same line is asked for again, so it flashes again.
 */
export type PeekState = { flowId: string; stepId: string; line: number | null; nonce?: number };

type PeekProps = Parameters<typeof Peek>[0];

type Props = {
  /** 'panel': fills the map panel and splits its height; 'card': inside an overview card. */
  place: 'panel' | 'card';
  flow: Flow;
  currentId: string;
  /** Shown here only when it is a peek of this flow. */
  peek: PeekState | null;
  /** Everything Peek needs that is not about the step. */
  peekProps: Omit<
    PeekProps,
    'flow' | 'stepId' | 'line' | 'nonce' | 'seen' | 'onMove' | 'onClose' | 'headingLevel'
  > & {
    isSeen: (id: string) => boolean;
  };
  onPeek: (peek: PeekState | null) => void;
};

/** Where the split is kept in local storage. */
const STORAGE_KEY = 'pr-tour.peek-split';
/**
 * The two remembered sizes, as shares: in the panel, the map's share of the height; in a card,
 * the peek's height as a share of the window.
 */
type Split = { panel: number; card: number };
const DEFAULT_SPLIT: Split = { panel: 0.4, card: 0.6 };
const MIN = 0.15;
const MAX = 0.85;
/** How far one arrow key moves the divider. */
const STEP = 0.05;

/** Tells one line peek from the next, so the same arrow clicked twice flashes again. */
let peekSeq = 0;

function clamp(n: number): number {
  return Math.round(Math.min(MAX, Math.max(MIN, n)) * 100) / 100;
}

/** A stored share, or the default when it is missing, not a number or out of bounds. */
function share(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= MIN && value <= MAX ? value : fallback;
}

/** A stored split, read field by field: bad fields fall back to their default. */
function parse(raw: string | null): Split {
  if (raw === null) return DEFAULT_SPLIT;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SPLIT;
    const { panel, card } = parsed as Record<string, unknown>;
    return { panel: share(panel, DEFAULT_SPLIT.panel), card: share(card, DEFAULT_SPLIT.card) };
  } catch {
    // Not JSON: start from the defaults.
    return DEFAULT_SPLIT;
  }
}

/*
 * The split is shared by every map on screen (the map panel and the overview cards stay
 * mounted together), so it lives here, read from storage each time and changed one place at a
 * time. Each save tells every map.
 */
const listeners = new Set<() => void>();
/** The last stored text and what it reads as: the same object while the text stays the same. */
let cache: { raw: string | null; split: Split } = { raw: null, split: DEFAULT_SPLIT };
/** The split while storage is blocked: kept for as long as the page lives. */
let memory: Split | null = null;

function readSplit(): Split {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return memory ?? DEFAULT_SPLIT;
  }
  if (raw !== cache.raw) cache = { raw, split: parse(raw) };
  return cache.split;
}

/** Changes only `place`'s share, on top of what is stored now. */
function saveShare(place: keyof Split, value: number): void {
  const updated = { ...readSplit(), [place]: clamp(value) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Storage blocked: the split holds until the page reloads.
    memory = updated;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A flow map with a peek of one step below it, and a divider between them that sets their
 * sizes. A click on a box or a calling line asks for a peek; the caller owns which peek is
 * open, so one peek at a time can hold across maps.
 */
export function MapWithPeek({ place, flow, currentId, peek, peekProps, onPeek }: Props): ReactNode {
  const split = useSyncExternalStore(subscribe, readSplit);
  // While dragging, the divider follows the pointer here; it is saved when let go.
  const [dragged, setDragged] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; card: number } | null>(null);
  const shown = peek?.flowId === flow.id ? peek : null;
  const value = dragged ?? split[place];

  const { isSeen, ...rest } = peekProps;

  /** Where the divider goes for a pointer at `y`. */
  function valueAt(y: number): number | null {
    const start = drag.current;
    if (!start) return null;
    if (place === 'card') return start.card + (start.y - y) / window.innerHeight;
    const box = root.current?.getBoundingClientRect();
    if (!box || box.height <= 0) return null;
    return (y - box.top) / box.height;
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { y: e.clientY, card: split.card };
    // jsdom has no pointer capture.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const next = valueAt(e.clientY);
    if (next !== null) setDragged(clamp(next));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const next = valueAt(e.clientY) ?? value;
    drag.current = null;
    setDragged(null);
    saveShare(place, next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    // Up moves the divider up: a smaller map in the panel, a taller peek in a card.
    const up = e.key === 'ArrowUp';
    const delta = place === 'panel' ? (up ? -STEP : STEP) : up ? STEP : -STEP;
    saveShare(place, value + delta);
  }

  // The sizes go to the stylesheet, which also drops them on narrow windows.
  const sizes = (place === 'panel'
    ? { '--map-share': String(value) }
    : { '--peek-height': `${Math.round(value * 100)}vh` }) as Record<
    string,
    string
  > as CSSProperties;

  return (
    <div ref={root} className={`map-peek ${place}${shown ? ' peeking' : ''}`} style={sizes}>
      <div className="map-peek-map">
        {/* A fresh map per flow: fold choices never carry over. */}
        <FlowMap
          key={flow.id}
          flow={flow}
          currentId={currentId}
          peekedId={shown?.stepId ?? null}
          onOpenStep={(stepId) => onPeek({ flowId: flow.id, stepId, line: null })}
          onOpenLine={(stepId, _file, line) =>
            onPeek({ flowId: flow.id, stepId, line, nonce: ++peekSeq })
          }
          {...(place === 'card' && { headingLevel: 5 as const })}
        />
      </div>
      {shown && (
        <>
          <div
            className="map-peek-divider"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the map and the peek"
            aria-valuenow={Math.round(value * 100)}
            aria-valuemin={MIN * 100}
            aria-valuemax={MAX * 100}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              drag.current = null;
              setDragged(null);
            }}
            onKeyDown={onKeyDown}
          />
          <div className="map-peek-peek">
            {/* Only shown on narrow windows, where the peek covers the map. */}
            <button
              type="button"
              className="link-button map-peek-back"
              onClick={() => onPeek(null)}
            >
              ← Map
            </button>
            <Peek
              {...rest}
              flow={flow}
              stepId={shown.stepId}
              line={shown.line}
              {...(shown.nonce !== undefined && { nonce: shown.nonce })}
              seen={isSeen(shown.stepId)}
              onMove={(stepId, line) => onPeek({ flowId: flow.id, stepId, line })}
              onClose={() => onPeek(null)}
              // Under the card's h4.
              {...(place === 'card' && { headingLevel: 5 as const })}
            />
          </div>
        </>
      )}
    </div>
  );
}
