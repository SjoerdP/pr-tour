import { describe, expect, it } from 'vitest';
import type { Flow, FlowLink, Step } from '../../src/shared/tour.js';
import { buildFlowMap, type MapNode } from '../../src/web/flow-map.js';

function step(id: string, extra: Partial<Step> = {}): Step {
  return {
    id,
    title: `Repay ${id}`,
    file: 'loans/repay.go',
    startLine: 1,
    endLine: 50,
    changed: false,
    why: '',
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes: [],
    ...extra,
  };
}

function flow(steps: Step[], links?: FlowLink[]): Flow {
  return {
    id: 'F1',
    title: 'Repay a loan',
    entry: { kind: 'http', label: 'POST /loans/{id}/repay' },
    steps,
    ...(links && { links }),
  };
}

function link(
  from: string,
  to: string,
  line: number,
  check: FlowLink['check'] = 'proven',
): FlowLink {
  return { from, to, line, how: 'call', source: 'both', check };
}

const steps = (...ids: string[]) => ids.map((id) => step(id));

/** Every node of the tree, depth first. */
function nodes(node: MapNode | null): MapNode[] {
  return node ? [node, ...node.children.flatMap(nodes)] : [];
}

function find(root: MapNode | null, id: string): MapNode {
  const node = nodes(root).find((n) => n.step.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

describe('buildFlowMap', () => {
  it('puts each step under its caller, children in calling-line order', () => {
    const map = buildFlowMap(
      flow(steps('S1', 'S2', 'S3', 'S4'), [
        link('S1', 'S2', 10),
        link('S2', 'S4', 30),
        link('S2', 'S3', 20),
      ]),
    );
    expect(map.source).toBe('links');
    expect(map.root?.step.id).toBe('S1');
    expect(map.root?.no).toBe(1);
    expect(map.root?.edge).toEqual({
      from: null,
      to: 'S1',
      line: null,
      how: 'call',
      via: [],
      proof: 'proven',
    });
    const s2 = map.root!.children[0]!;
    expect(s2.step.id).toBe('S2');
    expect(s2.children.map((n) => n.step.id)).toEqual(['S3', 'S4']);
    expect(s2.children.map((n) => n.no)).toEqual([3, 4]);
    expect(map.unlinked).toEqual([]);
  });

  it('a proven caller wins over a lower-numbered Claude-only caller', () => {
    const map = buildFlowMap(
      flow(steps('S1', 'S2', 'S3', 'S4'), [
        link('S1', 'S2', 10),
        link('S1', 'S3', 11),
        link('S2', 'S4', 20, 'not-found'),
        link('S3', 'S4', 30),
      ]),
    );
    expect(find(map.root, 'S3').children.map((n) => n.step.id)).toEqual(['S4']);
    const s4 = find(map.root, 'S4');
    expect(s4.edge.from).toBe('S3');
    expect(s4.alsoFrom).toEqual([
      { from: 'S2', to: 'S4', line: 20, how: 'call', via: [], proof: 'not-found' },
    ]);
    expect(s4.loopsFrom).toEqual([]);
  });

  it('loops and unknown steps do not break the tree', () => {
    const map = buildFlowMap(
      flow(steps('S1', 'S2', 'S3'), [
        link('S1', 'S2', 10),
        link('S2', 'S3', 20),
        link('S3', 'S2', 30),
        link('S2', 'S9', 40),
        link('S9', 'S3', 50),
      ]),
    );
    const ids = [...nodes(map.root), ...map.unlinked.flatMap(nodes)].map((n) => n.step.id);
    expect(ids).toEqual(['S1', 'S2', 'S3']);
  });

  it('a call back up the tree is marked as a loop', () => {
    const map = buildFlowMap(
      flow(steps('S1', 'S2', 'S3'), [
        link('S1', 'S2', 10),
        link('S2', 'S3', 20),
        link('S3', 'S2', 42),
      ]),
    );
    const s2 = find(map.root, 'S2');
    const s3 = find(map.root, 'S3');
    const back = { from: 'S3', to: 'S2', line: 42, how: 'call', via: [], proof: 'proven' };
    expect(s2.loopsFrom).toEqual([back]);
    expect(s3.loopsTo).toEqual([back]);
    expect(s2.alsoFrom).toEqual([]);
    expect(s3.loopsFrom).toEqual([]);
  });

  it('a step that calls itself is a loop', () => {
    const map = buildFlowMap(flow(steps('S1', 'S2'), [link('S1', 'S2', 10), link('S2', 'S2', 15)]));
    const s2 = find(map.root, 'S2');
    const self = { from: 'S2', to: 'S2', line: 15, how: 'call', via: [], proof: 'proven' };
    expect(s2.edge.from).toBe('S1');
    expect(s2.loopsFrom).toEqual([self]);
    expect(s2.loopsTo).toEqual([self]);
    expect(s2.alsoFrom).toEqual([]);
  });

  it('a second caller that is not below is not a loop', () => {
    const map = buildFlowMap(
      flow(steps('S1', 'S2', 'S3'), [
        link('S1', 'S2', 10),
        link('S1', 'S3', 12),
        link('S2', 'S3', 20),
      ]),
    );
    const s3 = find(map.root, 'S3');
    expect(s3.edge.from).toBe('S1');
    expect(s3.alsoFrom.map((e) => [e.from, e.line])).toEqual([['S2', 20]]);
    expect(s3.loopsFrom).toEqual([]);
    expect(find(map.root, 'S2').loopsTo).toEqual([]);
  });

  it('two siblings that call each other are a loop on both ends', () => {
    const map = buildFlowMap(
      flow(steps('S1', 'S2', 'S3'), [
        link('S1', 'S2', 10),
        link('S1', 'S3', 11),
        link('S2', 'S3', 20),
        link('S3', 'S2', 30),
      ]),
    );
    const s2 = find(map.root, 'S2');
    const s3 = find(map.root, 'S3');
    const there = { from: 'S2', to: 'S3', line: 20, how: 'call', via: [], proof: 'proven' };
    const back = { from: 'S3', to: 'S2', line: 30, how: 'call', via: [], proof: 'proven' };
    expect(s2.edge.from).toBe('S1');
    expect(s3.edge.from).toBe('S1');
    expect(s2.loopsFrom).toEqual([back]);
    expect(s2.loopsTo).toEqual([there]);
    expect(s3.loopsFrom).toEqual([there]);
    expect(s3.loopsTo).toEqual([back]);
    expect(s2.alsoFrom).toEqual([]);
    expect(s3.alsoFrom).toEqual([]);
  });

  it('a circle across branches is a loop, not "also called from"', () => {
    // S2 -> S3 -> S4 -> S2, with S2 and S3 both under S1.
    const map = buildFlowMap(
      flow(steps('S1', 'S2', 'S3', 'S4'), [
        link('S1', 'S2', 10),
        link('S1', 'S3', 11),
        link('S3', 'S4', 20),
        link('S4', 'S2', 30),
        link('S2', 'S3', 40),
      ]),
    );
    const s2 = find(map.root, 'S2');
    const s3 = find(map.root, 'S3');
    const s4 = find(map.root, 'S4');
    expect(s4.edge.from).toBe('S3');
    expect(s2.loopsFrom.map((e) => [e.from, e.line])).toEqual([['S4', 30]]);
    expect(s4.loopsTo.map((e) => [e.to, e.line])).toEqual([['S2', 30]]);
    expect(s3.loopsFrom.map((e) => [e.from, e.line])).toEqual([['S2', 40]]);
    expect(s2.loopsTo.map((e) => [e.to, e.line])).toEqual([['S3', 40]]);
    expect([s2, s3, s4].flatMap((n) => n.alsoFrom)).toEqual([]);
  });

  it('a call back into step 1 is a loop', () => {
    const map = buildFlowMap(flow(steps('S1', 'S2'), [link('S1', 'S2', 10), link('S2', 'S1', 30)]));
    const back = { from: 'S2', to: 'S1', line: 30, how: 'call', via: [], proof: 'proven' };
    expect(map.root!.loopsFrom).toEqual([back]);
    expect(find(map.root, 'S2').loopsTo).toEqual([back]);
    expect(map.root!.alsoFrom).toEqual([]);
  });

  it('two steps that only reach each other: one unlinked, the other its child, with loop notes', () => {
    const map = buildFlowMap(
      flow(steps('S1', 'S2', 'S3'), [link('S2', 'S3', 20), link('S3', 'S2', 30)]),
    );
    expect(map.root!.children).toEqual([]);
    expect(map.unlinked.map((n) => n.step.id)).toEqual(['S3']);
    const s3 = map.unlinked[0]!;
    const s2 = s3.children[0]!;
    expect(s2.step.id).toBe('S2');
    expect(s2.edge.from).toBe('S3');
    const there = { from: 'S2', to: 'S3', line: 20, how: 'call', via: [], proof: 'proven' };
    expect(s3.loopsFrom).toEqual([there]);
    expect(s2.loopsTo).toEqual([there]);
    expect(s3.alsoFrom).toEqual([]);
  });

  it('the first call on the lowest line is the arrow when the proof is the same', () => {
    const map = buildFlowMap(flow(steps('S1', 'S2'), [link('S1', 'S2', 30), link('S1', 'S2', 10)]));
    const s2 = find(map.root, 'S2');
    expect(s2.edge.line).toBe(10);
    expect(s2.alsoFrom.map((e) => e.line)).toEqual([30]);
  });

  it('a conflict counts as not found', () => {
    const map = buildFlowMap(flow(steps('S1', 'S2'), [link('S1', 'S2', 10, 'conflict')]));
    expect(find(map.root, 'S2').edge.proof).toBe('not-found');
  });

  it('a "from" with a step number outside the flow is ignored', () => {
    const map = buildFlowMap(
      flow([step('S1'), step('S2', { from: { step: 9, line: 7, how: 'call' } })]),
    );
    expect(map.root!.children).toEqual([]);
    expect(map.unlinked.map((n) => n.step.id)).toEqual(['S2']);
    expect(map.unlinked[0]!.edge.from).toBeNull();
  });

  it('a step nothing reaches is listed as unlinked', () => {
    const map = buildFlowMap(flow(steps('S1', 'S2', 'S3'), [link('S1', 'S2', 10)]));
    expect(map.unlinked.map((n) => n.step.id)).toEqual(['S3']);
    expect(map.unlinked[0]!.no).toBe(3);
    expect(map.unlinked[0]!.edge).toEqual({
      from: null,
      to: 'S3',
      line: null,
      how: 'call',
      via: [],
      proof: 'unchecked',
    });
  });

  it('keeps a duplicate edge once, with the best proof', () => {
    const map = buildFlowMap(
      flow(steps('S1', 'S2'), [link('S1', 'S2', 10, 'not-found'), link('S1', 'S2', 10, 'proven')]),
    );
    const s2 = find(map.root, 'S2');
    expect(s2.edge.proof).toBe('proven');
    expect(s2.alsoFrom).toEqual([]);
  });

  it('without links, edges come from the tour own "from", unchecked', () => {
    const map = buildFlowMap(
      flow([step('S1'), step('S2', { from: { step: 1, line: 7, how: 'call', via: 'helper' } })]),
    );
    expect(map.source).toBe('from');
    expect(find(map.root, 'S2').edge).toEqual({
      from: 'S1',
      to: 'S2',
      line: 7,
      how: 'call',
      via: ['helper'],
      proof: 'unchecked',
    });
  });

  it('without links or from, every step but the first is unlinked', () => {
    const map = buildFlowMap(flow(steps('S1', 'S2', 'S3')));
    expect(map.source).toBe('none');
    expect(map.root?.step.id).toBe('S1');
    expect(map.unlinked.map((n) => n.step.id)).toEqual(['S2', 'S3']);
  });

  it('a flow without steps has no root', () => {
    expect(buildFlowMap(flow([]))).toEqual({ source: 'none', root: null, unlinked: [] });
  });

  it('counts changed steps below each node', () => {
    const changed = step('S3', {
      changed: true,
      homes: [{ file: 'loans/repay.go', side: 'new', start: 3, end: 9 }],
    });
    const map = buildFlowMap(
      flow([step('S1'), step('S2'), changed], [link('S1', 'S2', 10), link('S2', 'S3', 20)]),
    );
    expect(map.root!.changesBelow).toBe(1);
    expect(find(map.root, 'S2').changesBelow).toBe(1);
    expect(find(map.root, 'S3').changesBelow).toBe(0);
  });
});
