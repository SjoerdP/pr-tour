import { useEffect, useRef } from 'react';

/** True when the key press goes into a text field, where letters are typing, not shortcuts. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/**
 * Single-key shortcuts on the whole page: `map[event.key]` runs on key down.
 * Ignored while typing in a text field and when a modifier (Ctrl, Alt, Meta) is held,
 * so browser shortcuts keep working.
 */
export function useKeys(map: Record<string, () => void>): void {
  // Read the latest map on each key press, so callers can pass a fresh object every render.
  const latest = useRef(map);
  useEffect(() => {
    latest.current = map;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (isTyping(event.target)) return;
      const action = latest.current[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
