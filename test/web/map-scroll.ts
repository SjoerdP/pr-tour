import { vi } from 'vitest';

/**
 * jsdom does no layout. This places each flow map and its peeked box, so the map's own scroll
 * can be checked: a map at (100, 50), 400 by 200, and the peeked box at (900, 650), 100 by 40.
 * Centred, that box needs scrollLeft 650 and scrollTop 520. `scrollIntoView` is a spy: the map
 * must not use it, as it would scroll the page around the map too.
 */
export function placeMapBoxes() {
  const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  });
  const isMap = (el: Element) => el.classList.contains('flow-map');
  const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (isMap(this)) return rect(100, 50, 400, 200);
    if (this.matches('.flow-map-box.peeked')) return rect(900, 650, 100, 40);
    return rect(0, 0, 0, 0);
  });
  const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: Element,
  ) {
    return isMap(this) ? 400 : 0;
  });
  const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: Element,
  ) {
    return isMap(this) ? 200 : 0;
  });
  const before = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  return {
    scrollIntoView,
    /** Puts back what was there. */
    restore() {
      for (const spy of [box, width, height]) spy.mockRestore();
      if (before) Object.defineProperty(Element.prototype, 'scrollIntoView', before);
      else delete (Element.prototype as Partial<Element>).scrollIntoView;
    },
  };
}

/** Where a map's own scroll is now. */
export const scrolled = (map: Element) => ({ left: map.scrollLeft, top: map.scrollTop });
