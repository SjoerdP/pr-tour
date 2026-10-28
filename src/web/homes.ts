// The tour's homes in the order the web shows them (outline and j/k).

import type { Flow, Foundation, OtherGroup, OtherItem, Step, Tour } from '../shared/tour.js';

/** One place a changed line can live: a foundation, a flow step or an other-changes item. */
export type Home =
  | { kind: 'foundation'; id: string; foundation: Foundation }
  | { kind: 'step'; id: string; step: Step; flow: Flow }
  | { kind: 'other'; id: string; item: OtherItem; group: OtherGroup };

/**
 * The other-changes groups in display order: unexplained lines first (they are the ones
 * most worth a look), then the rest in tour order.
 */
export function otherGroupsInOrder(tour: Tour): OtherGroup[] {
  return [
    ...tour.other.filter((g) => g.kind === 'unexplained'),
    ...tour.other.filter((g) => g.kind !== 'unexplained'),
  ];
}

/** Every home in the order the outline lists them, which is also the j/k order. */
export function homesInOrder(tour: Tour): Home[] {
  return [
    ...tour.foundations.map((foundation): Home => ({
      kind: 'foundation',
      id: foundation.id,
      foundation,
    })),
    ...tour.flows.flatMap((flow) =>
      flow.steps.map((step): Home => ({ kind: 'step', id: step.id, step, flow })),
    ),
    ...otherGroupsInOrder(tour).flatMap((group) =>
      group.items.map((item): Home => ({ kind: 'other', id: item.id, item, group })),
    ),
  ];
}
