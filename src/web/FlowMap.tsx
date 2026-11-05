import { useId, useState, type ReactNode } from 'react';
import type { Flow, Step } from '../shared/tour.js';
import { buildFlowMap, type MapEdge, type MapNode, type MapProof } from './flow-map.js';
import { effectWords } from './Outline.js';

type Props = {
  flow: Flow;
  /** The step being read: marked "you are here". */
  currentId: string;
  /** A box was clicked. */
  onOpenStep: (stepId: string) => void;
  /** An arrow was clicked: the calling step, its file and the calling line. */
  onOpenLine: (stepId: string, file: string, line: number) => void;
  /** The level of the map's own headings: 3 under the flow map panel's h2 (the default). */
  headingLevel?: 3 | 4 | 5 | 6;
};

/** What a box needs besides its node: shared by every box of the map. */
type Ctx = Omit<Props, 'flow'> & {
  stepOf: (id: string) => Step;
  /** The step's 1-based number in the flow. */
  noOf: (id: string) => number;
  /** Flows with more steps than this start with their branches without changes folded. */
  big: boolean;
  isOpen: (node: MapNode) => boolean;
  toggle: (node: MapNode) => void;
};

/** Flows with more steps than this fold branches without changes at the start. */
const FOLD_ABOVE = 12;

/** The words for how a step reaches the next; a plain call needs none. */
const HOW_WORDS: Record<MapEdge['how'], string | null> = {
  call: null,
  register: 'registers',
  service: 'request',
  event: 'event',
};

/** What an arrow says about its proof; a link found by name says nothing extra. */
const PROOF_WORDS: Record<MapProof, string | null> = {
  proven: '✓ proven',
  'name-match': null,
  'not-found': 'not found in the code',
  unchecked: 'not checked',
};

/** Only the tour claims it: drawn dashed. */
function unproven(edge: MapEdge): boolean {
  return edge.proof === 'not-found' || edge.proof === 'unchecked';
}

/** " (not checked)" after a loop or "also called" line the code does not back up. */
function proofNote(edge: MapEdge): string {
  return unproven(edge) ? ` (${PROOF_WORDS[edge.proof]})` : '';
}

/** The last two parts of a path: enough to tell files apart. */
function shortFile(file: string): string {
  return file.split('/').slice(-2).join('/');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Steps below `node`, at any depth. */
function stepsBelow(node: MapNode): number {
  return node.children.reduce((sum, child) => sum + 1 + stepsBelow(child), 0);
}

/** Whether step `id` is `node` or below it. */
function holds(node: MapNode, id: string): boolean {
  return node.step.id === id || node.children.some((c) => holds(c, id));
}

function hasLoop(node: MapNode): boolean {
  return node.loopsFrom.length > 0 || node.children.some(hasLoop);
}

/** A flow drawn as a tree of calls: each step under the step that calls it. */
export function FlowMap({ flow, headingLevel = 3, ...props }: Props): ReactNode {
  const map = buildFlowMap(flow);
  // The reader's fold choices, per step id; a step not in here has its starting state.
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  const steps = new Map(flow.steps.map((s) => [s.id, s]));
  const nos = new Map(flow.steps.map((s, i) => [s.id, i + 1]));
  const big = flow.steps.length > FOLD_ABOVE;
  // Open when something below has changes, and never hiding the step being read. A step
  // under the entry (the first one, and each unlinked one) is always open.
  const startsOpen = (node: MapNode) =>
    !big ||
    node.edge.from === null ||
    node.changesBelow > 0 ||
    node.children.some((c) => holds(c, props.currentId));
  const isOpen = (node: MapNode) => opened[node.step.id] ?? startsOpen(node);
  const ctx: Ctx = {
    ...props,
    stepOf: (id) => steps.get(id)!,
    noOf: (id) => nos.get(id)!,
    big,
    isOpen,
    toggle: (node) => setOpened((o) => ({ ...o, [node.step.id]: !isOpen(node) })),
  };
  const unlinkedHead = useId();
  const Heading = `h${headingLevel}` as const;
  const loops = [map.root, ...map.unlinked].some((n) => n !== null && hasLoop(n));

  return (
    <div className="flow-map">
      <Key loops={loops} />
      {map.source === 'from' && (
        <p className="flow-map-notice">
          The code check did not run for this flow. The arrows are the tour's own claims.
        </p>
      )}
      {map.source === 'none' && (
        <p className="flow-map-notice">The code check did not run. The steps are shown in order.</p>
      )}
      {map.root ? (
        <ul aria-label="Calls in this flow" className="flow-map-tree">
          <Branch node={map.root} ctx={ctx} entry={flow.entry.label} />
        </ul>
      ) : (
        <p className="flow-map-entry" title={flow.entry.label}>
          {flow.entry.label}
        </p>
      )}
      {map.unlinked.length > 0 && (
        <section className="flow-map-unlinked" aria-labelledby={unlinkedHead}>
          <Heading id={unlinkedHead} className="flow-map-unlinked-title">
            Not linked to the steps above
          </Heading>
          <Row nodes={map.unlinked} ctx={ctx} label="Steps not linked" />
        </section>
      )}
    </div>
  );
}

function Key({ loops }: { loops: boolean }) {
  return (
    <ul className="flow-map-key" aria-label="Key">
      <li>
        <span className="flow-map-swatch changed" aria-hidden="true" />
        Blue edge: the step has changes
      </li>
      <li>
        <span className="flow-map-swatch unchanged" aria-hidden="true" />
        Dashed: no changes, here to show the flow
      </li>
      <li>
        <span className="flow-map-swatch read-closely" aria-hidden="true" />
        Orange outline: read closely
      </li>
      <li>Arrow: this step calls the box below it, on that line</li>
      {loops && (
        <li className="flow-map-key-loop">↻ Loop: these steps call each other in a circle</li>
      )}
    </ul>
  );
}

/** Steps side by side, in calling-line order. */
function Row({ nodes, ctx, label }: { nodes: MapNode[]; ctx: Ctx; label?: string }) {
  return (
    <ul aria-label={label} className="flow-map-row">
      {nodes.map((node) => (
        <Branch key={node.step.id} node={node} ctx={ctx} />
      ))}
    </ul>
  );
}

/**
 * One step: the arrow into it, its box, and the steps it calls. The first step's arrow comes
 * from the flow's entry.
 */
function Branch({ node, ctx, entry }: { node: MapNode; ctx: Ctx; entry?: string }) {
  const hasChildren = node.children.length > 0;
  const open = !hasChildren || ctx.isOpen(node);
  return (
    <li className={`flow-map-branch${unproven(node.edge) ? ' unproven' : ''}`}>
      {entry !== undefined ? (
        <span className="flow-map-link">
          <span className="flow-map-entry" title={entry}>
            {entry}
          </span>
          <span className="flow-map-stem" aria-hidden="true" />
        </span>
      ) : (
        <Arrow edge={node.edge} ctx={ctx} />
      )}
      <Card node={node} ctx={ctx} />
      {hasChildren && open && <Row nodes={node.children} ctx={ctx} />}
    </li>
  );
}

/** The label on the arrow into a box: the calling line, how, the helpers between, the proof. */
function Arrow({ edge, ctx }: { edge: MapEdge; ctx: Ctx }) {
  if (edge.from === null || edge.line === null) return null;
  const { from, line } = edge;
  const words = [
    `line ${line}`,
    HOW_WORDS[edge.how],
    edge.via.length > 0 ? `via ${edge.via.join(', ')}` : null,
    PROOF_WORDS[edge.proof],
  ].filter((w) => w !== null);
  const dashed = unproven(edge) ? ' unproven' : '';
  return (
    <span className="flow-map-link">
      <button
        type="button"
        className={`flow-map-edge${dashed}`}
        title={`Open the calling line in step ${ctx.noOf(from)}`}
        onClick={() => ctx.onOpenLine(from, ctx.stepOf(from).file, line)}
      >
        {words.join(' · ')}
      </button>
      <span className={`flow-map-stem${dashed}`} aria-hidden="true" />
    </span>
  );
}

/** A step's box, with the lines below it: other callers, loops and the fold button. */
function Card({ node, ctx }: { node: MapNode; ctx: Ctx }) {
  const { step, no } = node;
  const current = step.id === ctx.currentId;
  const inLoop = node.loopsFrom.length > 0 || node.loopsTo.length > 0;
  const name = step.anchor?.name ?? step.symbol;
  const changes = step.homes.length;
  const looks = [
    changes > 0 ? 'changed' : 'unchanged',
    step.risk === 'read-closely' && 'read-closely',
    inLoop && 'in-loop',
  ]
    .filter(Boolean)
    .join(' ');

  // Lines under the box. Each opens the calling line of its edge (in the calling step).
  const loopNotes = [
    ...node.loopsFrom.map((e) =>
      e.from === step.id
        ? `↻ Calls itself on line ${e.line}. Check that it stops.${proofNote(e)}`
        : `↻ Called again from step ${ctx.noOf(e.from!)}, line ${e.line}. Check that the loop stops.${proofNote(e)}`,
    ),
    ...node.loopsTo
      // A self-call is already said by the line above.
      .filter((e) => e.to !== step.id)
      .map((e) => `↻ Calls step ${ctx.noOf(e.to)} again on line ${e.line}${proofNote(e)}`),
  ];
  const loopEdges = [...node.loopsFrom, ...node.loopsTo.filter((e) => e.to !== step.id)];
  const alsoNotes = node.alsoFrom.map(
    (e) => `Also called from step ${ctx.noOf(e.from!)}, line ${e.line}${proofNote(e)}`,
  );

  const below = node.children.length > 0 && ctx.big ? stepsBelow(node) : 0;
  const open = ctx.isOpen(node);

  return (
    <div className={`flow-map-card ${looks}`}>
      <button
        type="button"
        className={`flow-map-box ${looks}`}
        aria-current={current ? 'step' : undefined}
        onClick={() => ctx.onOpenStep(step.id)}
      >
        <span className="flow-map-head">
          <span className="flow-map-no">Step {no}</span>
          {name && (
            <span className="flow-map-name" title={name}>
              {name}
            </span>
          )}
        </span>
        <span className="flow-map-file" title={step.file}>
          {shortFile(step.file)}
        </span>
        <span className="flow-map-title" title={step.title}>
          {step.title}
        </span>
        <span className="flow-map-tags">
          {current && <span className="flow-map-tag flow-map-here">You are here</span>}
          <span className="flow-map-tag">
            {changes > 0 ? plural(changes, 'change') : 'no changes'}
          </span>
          {step.risk === 'read-closely' && (
            <span className="flow-map-tag flow-map-rc">read closely</span>
          )}
          {effectWords(step.sideEffects).map(({ word, labels }) => (
            <span key={word} className="flow-map-tag" title={labels.join('; ')}>
              {word}
            </span>
          ))}
          {inLoop && <span className="flow-map-tag flow-map-loop">↻ Loop</span>}
        </span>
      </button>
      <Notes edges={loopEdges} texts={loopNotes} className="flow-map-loop-notes" ctx={ctx} />
      <Notes edges={node.alsoFrom} texts={alsoNotes} ctx={ctx} />
      {below > 0 && (
        <button
          type="button"
          className="flow-map-fold"
          aria-expanded={open}
          onClick={() => ctx.toggle(node)}
        >
          {open ? 'Hide steps below' : `${plural(below, 'step')} below`}
        </button>
      )}
    </div>
  );
}

/** Lines under a box, one per edge: each opens the edge's calling line. */
function Notes({
  edges,
  texts,
  className,
  ctx,
}: {
  edges: MapEdge[];
  texts: string[];
  className?: string;
  ctx: Ctx;
}) {
  if (edges.length === 0) return null;
  return (
    <div className={`flow-map-notes${className ? ` ${className}` : ''}`}>
      {edges.map((e, i) => {
        // Edges between steps always have a caller and a calling line.
        const from = e.from!;
        const line = e.line!;
        return (
          <button
            key={`${from} ${e.to} ${line}`}
            type="button"
            className="flow-map-note"
            onClick={() => ctx.onOpenLine(from, ctx.stepOf(from).file, line)}
          >
            {texts[i]}
          </button>
        );
      })}
    </div>
  );
}
