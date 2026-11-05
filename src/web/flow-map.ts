import type { Flow, FlowLink, Step } from '../shared/tour.js';

export type MapProof = 'proven' | 'name-match' | 'not-found' | 'unchecked';

/** A call from one step (null: the flow's entry) to another. */
export type MapEdge = {
  from: string | null;
  to: string;
  /** The calling line in the `from` step's file; null for the entry edge. */
  line: number | null;
  how: 'call' | 'register' | 'service' | 'event';
  via: string[];
  proof: MapProof;
};

export type MapNode = {
  step: Step;
  /** 1-based number in the flow. */
  no: number;
  /** The edge that places this node under its parent (from the entry for the root). */
  edge: MapEdge;
  children: MapNode[];
  /** Other edges into this step, not used for the tree, that do not close a circle. */
  alsoFrom: MapEdge[];
  /** Edges into this step that close a circle: from this step itself or a step below it. */
  loopsFrom: MapEdge[];
  /** Edges out of this step that close a circle (the same edges, seen from the caller). */
  loopsTo: MapEdge[];
  /** Number of steps in this node's subtree (itself excluded) that have changes. */
  changesBelow: number;
};

export type FlowMap = {
  /** 'links': from the code check; 'from': the tour's own claims; 'none': no edges at all. */
  source: 'links' | 'from' | 'none';
  /** The flow's first step, under the entry. Null for a flow without steps. */
  root: MapNode | null;
  /** Steps no edge reaches, in flow order; each with an entry edge of proof 'unchecked'. */
  unlinked: MapNode[];
};

/**
 * How well the code backs up a link. A conflict (the code found another caller) counts as
 * not found: the tour's claim is not backed up.
 */
function proofOf(check: FlowLink['check']): MapProof {
  return check === 'conflict' ? 'not-found' : check;
}

/** Proven first, then found by name, then the tour's own claim. */
function rank(proof: MapProof): number {
  if (proof === 'proven') return 0;
  if (proof === 'name-match') return 1;
  return 2;
}

/** An edge from the flow's entry to `step`. */
function entryEdge(step: Step, proof: MapProof): MapEdge {
  return { from: null, to: step.id, line: null, how: 'call', via: [], proof };
}

/** The flow's edges and where they come from, before dropping and merging. */
function rawEdges(flow: Flow): { source: FlowMap['source']; edges: MapEdge[] } {
  if (flow.links !== undefined) {
    const edges = flow.links.map((l) => ({
      from: l.from,
      to: l.to,
      line: l.line,
      how: l.how,
      via: l.via ?? [],
      proof: proofOf(l.check),
    }));
    return { source: 'links', edges };
  }
  const edges: MapEdge[] = [];
  for (const step of flow.steps) {
    const from = step.from;
    const caller = from && flow.steps[from.step - 1];
    if (!from || !caller) continue;
    const via = from.via ? [from.via] : [];
    edges.push({
      from: caller.id,
      to: step.id,
      line: from.line,
      how: from.how,
      via,
      proof: 'unchecked',
    });
  }
  return { source: flow.steps.some((s) => s.from) ? 'from' : 'none', edges };
}

/** Edges between steps of the flow, each (from, to, line) once with its best proof. */
function usableEdges(edges: MapEdge[], ids: Set<string>): MapEdge[] {
  const kept = new Map<string, MapEdge>();
  for (const edge of edges) {
    if (edge.from === null || !ids.has(edge.from) || !ids.has(edge.to)) continue;
    const key = `${edge.from} ${edge.to} ${edge.line}`;
    const had = kept.get(key);
    if (!had || rank(edge.proof) < rank(had.proof)) kept.set(key, edge);
  }
  return [...kept.values()];
}

/** Builds the call tree of a flow: each step under the step that calls it. */
export function buildFlowMap(flow: Flow): FlowMap {
  const { source, edges: raw } = rawEdges(flow);
  const first = flow.steps[0];
  if (!first) return { source, root: null, unlinked: [] };

  const noOf = new Map(flow.steps.map((s, i) => [s.id, i + 1]));
  const edges = usableEdges(raw, new Set(noOf.keys()));
  const byNo = (id: string | null) => (id === null ? 0 : noOf.get(id)!);

  // Pick each step's parent edge, in step order, never closing a circle.
  const parentEdge = new Map<string, MapEdge>();
  const hasAncestor = (id: string, ancestor: string): boolean => {
    for (let at: string | null = id; at !== null; at = parentEdge.get(at)?.from ?? null) {
      if (at === ancestor) return true;
    }
    return false;
  };
  for (const step of flow.steps.slice(1)) {
    const candidates = edges
      .filter((e) => e.to === step.id)
      .sort((a, b) => rank(a.proof) - rank(b.proof) || byNo(a.from) - byNo(b.from));
    const pick = candidates.find((e) => !hasAncestor(e.from!, step.id));
    if (pick) parentEdge.set(step.id, pick);
  }

  const nodeOf = new Map<string, MapNode>();
  flow.steps.forEach((step, i) => {
    const edge = i === 0 ? entryEdge(step, 'proven') : parentEdge.get(step.id);
    nodeOf.set(step.id, {
      step,
      no: i + 1,
      edge: edge ?? entryEdge(step, 'unchecked'),
      children: [],
      alsoFrom: [],
      loopsFrom: [],
      loopsTo: [],
      changesBelow: 0,
    });
  });

  const unlinked: MapNode[] = [];
  for (const step of flow.steps.slice(1)) {
    const node = nodeOf.get(step.id)!;
    const parent = parentEdge.get(step.id);
    if (parent) nodeOf.get(parent.from!)!.children.push(node);
    else unlinked.push(node);
  }
  for (const node of nodeOf.values()) {
    node.children.sort((a, b) => a.edge.line! - b.edge.line! || a.no - b.no);
  }

  // Sort the edges the tree does not use: a caller at or below the step closes a circle.
  const order = (a: MapEdge, b: MapEdge) => byNo(a.from) - byNo(b.from) || a.line! - b.line!;
  for (const edge of [...edges].sort(order)) {
    if (parentEdge.get(edge.to) === edge) continue;
    const target = nodeOf.get(edge.to)!;
    if (hasAncestor(edge.from!, edge.to)) {
      target.loopsFrom.push(edge);
      nodeOf.get(edge.from!)!.loopsTo.push(edge);
    } else {
      target.alsoFrom.push(edge);
    }
  }

  const root = nodeOf.get(first.id)!;
  for (const node of [root, ...unlinked]) countChanges(node);
  return { source, root, unlinked };
}

/** Fills in `changesBelow` for `node` and its subtree; returns the changed steps in it. */
function countChanges(node: MapNode): number {
  node.changesBelow = node.children.reduce((sum, child) => sum + countChanges(child), 0);
  return node.changesBelow + (node.step.homes.length > 0 ? 1 : 0);
}
