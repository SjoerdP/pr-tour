import {
  useRef,
  useState,
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
    'flow' | 'stepId' | 'line' | 'nonce' | 'seen' | 'onMove' | 'onClose'
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

function loadSplit(): Split {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SPLIT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SPLIT;
    const { panel, card } = parsed as Record<string, unknown>;
    return { panel: share(panel, DEFAULT_SPLIT.panel), card: share(card, DEFAULT_SPLIT.card) };
  } catch {
    // Storage blocked or a value that is not JSON: start from the defaults.
    return DEFAULT_SPLIT;
  }
}

function saveSplit(split: Split): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(split));
  } catch {
    // Storage blocked: the split holds until the page reloads.
  }
}

/**
 * A flow map with a peek of one step below it, and a divider between them that sets their
 * sizes. A click on a box or a calling line asks for a peek; the caller owns which peek is
 * open, so one peek at a time can hold across maps.
 */
export function MapWithPeek({ place, flow, currentId, peek, peekProps, onPeek }: Props): ReactNode {
  const [split, setSplit] = useState<Split>(loadSplit);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; card: number } | null>(null);
  const shown = peek?.flowId === flow.id ? peek : null;
  const value = split[place];

  const { isSeen, ...rest } = peekProps;

  function setValue(next: number, save: boolean) {
    setSplit((old) => {
      const updated = { ...old, [place]: clamp(next) };
      if (save) saveSplit(updated);
      return updated;
    });
  }

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
    if (next !== null) setValue(next, false);
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const next = valueAt(e.clientY) ?? value;
    drag.current = null;
    setValue(next, true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    // Up moves the divider up: a smaller map in the panel, a taller peek in a card.
    const up = e.key === 'ArrowUp';
    const delta = place === 'panel' ? (up ? -STEP : STEP) : up ? STEP : -STEP;
    setValue(value + delta, true);
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
            onPointerCancel={() => (drag.current = null)}
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
            />
          </div>
        </>
      )}
    </div>
  );
}
