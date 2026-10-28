import { describe, expect, it } from 'vitest';
import type { Flow, Foundation, OtherGroup, Step, Tour } from '../../src/shared/tour.js';
import { homesInOrder, nextFlowStart, previousFlowStart } from '../../src/web/homes.js';

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
