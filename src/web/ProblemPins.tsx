import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { LEVEL_LABEL, LEVEL_ORDER, type PlacedProblem } from '../shared/problems.js';
import { ProblemCard } from './ProblemCard.js';
import { useProblemsContext } from './ProblemsContext.js';

// Pins: a coloured dot per possible problem on a step's outline row and on its map box. They
// sit beside the row or box button, never in it, so a pin click does not open the step.

/** Dots shown before the rest fold into one `+N`. */
const MAX_DOTS = 3;
/** The popup's width; also in the CSS (.problem-pop). */
const POP_WIDTH = 360;
/** Room kept free between the popup and the window's edges. */
const EDGE = 8;

/** Where the popup sits: under the pin, or above it when there is no room below. */
type Place = { left: number; top?: number; bottom?: number; maxHeight: number };

function placeBy(pin: HTMLElement): Place {
  const rect = pin.getBoundingClientRect();
  const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - POP_WIDTH - EDGE));
  const below = window.innerHeight - rect.bottom - 4 - EDGE;
  const above = rect.top - 4 - EDGE;
  return below >= 200 || below >= above
    ? { left, top: rect.bottom + 4, maxHeight: below }
    : { left, bottom: window.innerHeight - rect.top + 4, maxHeight: above };
}

/**
 * The problems on one home, as pins: worst first, without the ones marked "Not a problem".
 * A click shows the problem in a small popup, with "Go to the line" for a problem on a line.
 * Esc, a second click or a click outside shuts it.
 */
export function ProblemPins({ homeId }: { homeId: string }): ReactNode {
  const { problems, markOf, onGoTo } = useProblemsContext();
  const popId = useId();
  // Which pin is open (an index, or 'more' for `+N`) and where its popup sits.
  const [open, setOpen] = useState<{ pin: number | 'more'; place: Place } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const shown = problems
    .filter((p) => p.homeId === homeId && markOf(p.key) !== 'not')
    .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  const dots = shown.slice(0, MAX_DOTS);
  const rest = shown.slice(dots.length);
  const isOpen = open !== null;

  useEffect(() => {
    if (!isOpen) return;
    function onMouseDown(event: MouseEvent) {
      if (root.current?.contains(event.target as Node | null)) return;
      setOpen(null);
    }
    // Fixed in place: a scroll or resize would leave it behind, so it shuts.
    function onMove(event: Event) {
      if (event.target instanceof Node && pop.current?.contains(event.target)) return;
      setOpen(null);
    }
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [isOpen]);

  if (shown.length === 0) return null;

  function toggle(pin: number | 'more', button: HTMLElement) {
    setOpen(open?.pin === pin ? null : { pin, place: placeBy(button) });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || open === null) return;
    // The tour's own Esc (close the map, go back) must not run as well.
    event.stopPropagation();
    root.current?.querySelector<HTMLElement>('.problem-pin[aria-expanded="true"]')?.focus();
    setOpen(null);
  }

  function goTo(p: PlacedProblem) {
    setOpen(null);
    onGoTo?.(p);
  }

  // A pin can go while its popup is open (the problems were read again): then it shows nothing.
  const inPop = (open === null ? [] : open.pin === 'more' ? rest : [dots[open.pin]]).filter(
    (p): p is PlacedProblem => p !== undefined,
  );

  return (
    <div className="problem-pins" ref={root} onKeyDown={onKeyDown}>
      {dots.map((p, i) => {
        const label = `${LEVEL_LABEL[p.level]}: ${p.title}`;
        return (
          <button
            key={p.key}
            type="button"
            className={`problem-pin problem-${p.level}`}
            aria-label={label}
            title={label}
            aria-expanded={open?.pin === i}
            aria-controls={open?.pin === i ? popId : undefined}
            onClick={(e) => toggle(i, e.currentTarget)}
          >
            !
          </button>
        );
      })}
      {rest.length > 0 && (
        <button
          type="button"
          className="problem-pin problem-pin-more"
          aria-label={`${rest.length} more possible problems`}
          title={`${rest.length} more possible problems`}
          aria-expanded={open?.pin === 'more'}
          aria-controls={open?.pin === 'more' ? popId : undefined}
          onClick={(e) => toggle('more', e.currentTarget)}
        >
          +{rest.length}
        </button>
      )}
      {open && inPop.length > 0 && (
        <div
          ref={pop}
          id={popId}
          className="problem-pop"
          role="dialog"
          aria-label={inPop.length > 1 ? 'Possible problems' : 'Possible problem'}
          style={open.place}
        >
          {inPop.map((p) => (
            <div key={p.key} className="problem-pop-item">
              <ProblemCard problem={p} readOnly />
              {onGoTo && p.at.kind === 'line' && (
                <button type="button" className="link-button" onClick={() => goTo(p)}>
                  Go to the line
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
