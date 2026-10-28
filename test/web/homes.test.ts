import { describe, expect, it } from 'vitest';
import type { Flow, Foundation, OtherGroup, Step, Tour } from '../../src/shared/tour.js';
import {
  homeAt,
  homesInOrder,
  homeTouches,
  nextFlowStart,
  previousFlowStart,
  unseenForReview,
} from '../../src/web/homes.js';

function step(id: string): Step {
  return {
    id,
    title: id,
    file: 'a.ts',
    startLine: 1,
    endLine: 2,
    changed: true,
    why: 'w',
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes: [{ file: 'a.ts', side: 'new', start: 1, end: 2 }],
  };
}

function flow(id: string, stepCount: number): Flow {
  const steps = Array.from({ length: stepCount }, (_, i) => step(`${id}.S${i + 1}`));
  return { id, title: id, entry: { kind: 'http', label: 'GET /' }, steps };
}

function foundation(id: string): Foundation {
  return { id, kind: 'model', title: id, file: 'm.ts', why: 'w', risk: 'skim', homes: [] };
}

function group(kind: OtherGroup['kind'], ...ids: string[]): OtherGroup {
  return {
    kind,
    title: kind,
    summary: 's',
    items: ids.map((id) => ({ id, file: `${id}.ts`, title: id, homes: [] })),
  };
}

function tour(parts: Partial<Pick<Tour, 'foundations' | 'flows' | 'other'>>): Tour {
  return {
    repo: 'acme/loans',
    pr: 1,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    source: 'inferred',
    createdAt: '2026-10-28T12:00:00Z',
    summary: 's',
    foundations: [],
    flows: [],
    other: [],
    check: { problems: [] },
    hashes: {},
    ...parts,
  };
}

const full = homesInOrder(
  tour({
    foundations: [foundation('f1'), foundation('f2')],
    flows: [flow('F1', 3), flow('F2', 2)],
    // Unexplained comes first in display order, though it is last in the tour.
    other: [group('tests', 'o1.1'), group('unexplained', 'u1')],
  }),
);

describe('nextFlowStart', () => {
  it('goes from any step to the first step of the next flow', () => {
    expect(nextFlowStart(full, 'F1.S1')).toBe('F2.S1');
    expect(nextFlowStart(full, 'F1.S3')).toBe('F2.S1');
  });

  it('goes from the last flow to the first other-changes item in display order', () => {
    expect(nextFlowStart(full, 'F2.S2')).toBe('u1');
  });

  it('goes from a foundation to the first flow', () => {
    expect(nextFlowStart(full, 'f1')).toBe('F1.S1');
  });

  it('has nowhere to go from other changes', () => {
    expect(nextFlowStart(full, 'u1')).toBeUndefined();
    expect(nextFlowStart(full, 'o1.1')).toBeUndefined();
  });

  it('goes from a foundation to other changes when there are no flows', () => {
    const homes = homesInOrder(
      tour({ foundations: [foundation('f1')], other: [group('docs', 'o1.1')] }),
    );
    expect(nextFlowStart(homes, 'f1')).toBe('o1.1');
  });

  it('skips a flow without steps', () => {
    const homes = homesInOrder(tour({ flows: [flow('F1', 1), flow('F2', 0), flow('F3', 1)] }));
    expect(nextFlowStart(homes, 'F1.S1')).toBe('F3.S1');
  });

  it('has nowhere to go from the last flow without other changes', () => {
    const homes = homesInOrder(tour({ flows: [flow('F1', 2)] }));
    expect(nextFlowStart(homes, 'F1.S1')).toBeUndefined();
  });
});

describe('previousFlowStart', () => {
  it('goes from any step to the first step of the previous flow', () => {
    expect(previousFlowStart(full, 'F2.S1')).toBe('F1.S1');
    expect(previousFlowStart(full, 'F2.S2')).toBe('F1.S1');
  });

  it('goes from the first flow to the last foundation', () => {
    expect(previousFlowStart(full, 'F1.S2')).toBe('f2');
  });

  it('has nowhere to go from the first flow without foundations', () => {
    const homes = homesInOrder(tour({ flows: [flow('F1', 2)] }));
    expect(previousFlowStart(homes, 'F1.S2')).toBeUndefined();
  });

  it('goes from other changes to the first step of the last flow', () => {
    expect(previousFlowStart(full, 'o1.1')).toBe('F2.S1');
  });

  it('has nowhere to go from a foundation', () => {
    expect(previousFlowStart(full, 'f2')).toBeUndefined();
  });
});

describe('unseenForReview', () => {
  const risky = { ...step('F1.S2'), risk: 'read-closely' as const };
  const reviewTour = tour({
    foundations: [
      { ...foundation('f1'), homes: [{ file: 'm.ts', side: 'new', start: 1, end: 2 }] },
      foundation('f2'),
    ],
    flows: [{ ...flow('F1', 3), steps: [step('F1.S1'), risky, step('F1.S3')] }],
    other: [group('tests', 'o1.1')],
  });

  it('lists reviewable homes not seen, read-closely first, then display order', () => {
    const ids = unseenForReview(reviewTour, (id) => id === 'F1.S1').map((h) => h.id);
    // f2 and o1.1 own no changed lines: not review work.
    expect(ids).toEqual(['F1.S2', 'f1', 'F1.S3']);
  });

  it('is empty when everything was seen', () => {
    expect(unseenForReview(reviewTour, () => true)).toEqual([]);
  });
});

describe('homeAt and homeTouches', () => {
  const t = tour({
    flows: [
      {
        ...flow('F1', 1),
        steps: [{ ...step('F1.S1'), homes: [{ file: 'a.ts', side: 'new', start: 10, end: 20 }] }],
      },
    ],
    other: [
      {
        kind: 'generated',
        title: 'g',
        summary: 's',
        items: [{ id: 'o1.1', file: 'b.png', title: 'b', homes: [{ file: 'b.png', whole: true }] }],
      },
    ],
  });
  const [s1, o1] = homesInOrder(t);

  it('a range touches lines on its side and file that overlap it', () => {
    expect(homeTouches(s1!, 'a.ts', 'new', 18, 25)).toBe(true);
    expect(homeTouches(s1!, 'a.ts', 'old', 15, 15)).toBe(false);
    expect(homeTouches(s1!, 'b.ts', 'new', 15, 15)).toBe(false);
    expect(homeTouches(s1!, 'a.ts', 'new', 21, 30)).toBe(false);
  });

  it('a whole-file range touches anything on that file, file-level too', () => {
    expect(homeTouches(o1!, 'b.png', null, 1, 1)).toBe(true);
    // A file-level place has no lines: only a whole-file range owns it.
    expect(homeTouches(s1!, 'a.ts', null, 1, 1)).toBe(false);
  });

  it('homeAt finds the home owning a place, or none', () => {
    expect(homeAt(t, 'a.ts', 'new', 12, 12)?.id).toBe('F1.S1');
    expect(homeAt(t, 'a.ts', 'new', 2, 2)).toBeUndefined();
  });
});
