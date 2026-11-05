# Flow map in the tour: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the tour, a "Flow map" button (and key `m`) opens a map of the current flow: one box per step, one arrow per call, the current step marked, boxes and arrows clickable.

**Architecture:** A pure function turns a `Flow` into a tree model (`src/web/flow-map.ts`). A React component draws that model with HTML and CSS (`src/web/FlowMap.tsx`). `TourView` owns whether the map is open and wires clicks to the existing `goTo` and `openHome`. No server change.

**Tech Stack:** TypeScript, React 19, Vitest with Testing Library (jsdom), plain CSS in `src/web/styles.css`.

**Spec:** `docs/superpowers/specs/2026-11-05-pr-overview-and-flow-map-design.md` (sections "The flow map" and "Navigation"; this plan is PR 1 of 3: the map in the tour only. The overview screen, things to check, pins and "open on the first unseen home" are later PRs.)

## Global Constraints

- Plain English in UI copy: short sentences, common words.
- No real data from private repos in code, tests or commit messages: use the `acme/loans` example.
- Before the PR: `npm run check` passes (typecheck, lint, format, tests). The Go checker is not touched.
- `main` is protected: one PR, squash-merged. Commit messages: single line, conventional (`feat:`, `test:`, ...), no Co-Authored-By line.
- Check on screen with a separate pr-tour: `PR_TOUR_HOME=<scratch dir> PR_TOUR_PORT=4398 PR_TOUR_NO_OPEN=1 node dist/cli.js`. Never use `~/.pr-tour` for tests. Real-PR screenshots stay outside the repo.
- Arrows from links that only Claude claims are never drawn as proven (spec anti-goal).

## Review Focus

1. Links that loop (step 4 calls step 2, step 2 calls step 4) or point at a step id not in the flow: the map must still build a finite tree and show every step once. Tested in Task 1.
2. A flow without `links` (checker did not run) and without `from` (very old tour): the map still shows every step, with the right notice. Tested in Task 1 and Task 2.
3. A long flow (20+ steps) or long function names in a narrow window: the page never scrolls sideways; the map scrolls inside its panel. Tested in Task 2 (layout CSS contract) and checked on screen in Task 4.
4. The map is open and the reader moves to a foundation or other item (outline click, `j`), or a rebuild swaps the tour: the map closes, no crash. Tested in Task 3.
5. Pressing `m` while typing a review comment types an "m" and does not open the map (`useKeys` already ignores text fields). Tested in Task 3.

---

### Task 1: The map model

**Files:**
- Create: `src/web/flow-map.ts`
- Test: `test/web/flow-map.test.ts`

**Interfaces:**
- Consumes: `Flow`, `Step`, `FlowLink`, `StepFrom` from `src/shared/tour.ts`.
- Produces:

```ts
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

export function buildFlowMap(flow: Flow): FlowMap;
```

Rules (from the spec):
- `source` is `'links'` when `flow.links` is defined, else `'from'` when any step has `from`, else `'none'`.
- Edges with `'from'` source are built from each step's `from`: `{ from: steps[from.step - 1].id, line: from.line, how: from.how, via: from.via ? [from.via] : [], proof: 'unchecked' }`.
- Edges whose `from` or `to` is not a step of the flow are dropped. An edge with `from === to` (a step that calls itself) is kept as a loop edge.
- Duplicate edges (same `from`, `to` and `line`) are kept once, the best proof winning.
- The root is step 1, with edge `{ from: null, to: step1.id, line: null, how: 'call', via: [], proof: 'proven' }`.
- Each other step's parent is picked from its incoming edges by: proof rank (proven, then name-match, then not-found and unchecked), then the lowest `from` step number. A candidate whose parent chain already contains this step is skipped, so the tree never loops. Assign parents in step order.
- Children are sorted by edge `line`, then step number.
- The incoming edges not used for the tree are sorted into two lists once the tree is built: an edge whose `from` is the step itself or a step in its subtree closes a circle and goes to the step's `loopsFrom` and to the caller's `loopsTo`; any other goes to `alsoFrom`.
- A step with no usable incoming edge (not step 1) goes to `unlinked`.

- [ ] **Step 1: Write the failing tests** in `test/web/flow-map.test.ts`, with a small `step(id, extra)` and `flow(steps, links?)` helper on the `acme/loans` theme. Tests:
  - `'puts each step under its caller, children in calling-line order'`: links S1→S2 (line 10), S2→S4 (line 30), S2→S3 (line 20) → `root.step.id === 'S1'`, `root.children[0].step.id === 'S2'`, S2's children ids `['S3', 'S4']`, `source === 'links'`.
  - `'a proven caller wins over a lower-numbered Claude-only caller'`: S2→S4 `not-found`, S3→S4 `proven` → S4 sits under S3; S4's `alsoFrom` has the edge from S2 with `proof: 'not-found'`.
  - `'loops and unknown steps do not break the tree'`: links S1→S2, S2→S3, S3→S2 (proven), S2→S9, S9→S3 → every step appears exactly once (collect ids from root and unlinked: `['S1', 'S2', 'S3']`).
  - `'a call back up the tree is marked as a loop'`: links S1→S2 (line 10), S2→S3 (line 20), S3→S2 (line 42) → S2's `loopsFrom` has the edge from S3 with line 42, S3's `loopsTo` has the same edge, and S2's `alsoFrom` is empty.
  - `'a step that calls itself is a loop'`: links S1→S2, S2→S2 (line 15) → S2's `loopsFrom` and `loopsTo` both hold the S2→S2 edge.
  - `'a second caller that is not below is not a loop'`: links S1→S2, S1→S3, S2→S3 → S3 sits under S1 or S2 by the rules, and the other edge is in `alsoFrom`, not in `loopsFrom`.
  - `'a step nothing reaches is listed as unlinked'`: links S1→S2 only, three steps → `unlinked.map(n => n.step.id)` is `['S3']`.
  - `'without links, edges come from the tour own "from", unchecked'`: no `links`, S2 `from: { step: 1, line: 7, how: 'call', via: 'helper' }` → `source === 'from'`, S2 edge `{ from: 'S1', line: 7, via: ['helper'], proof: 'unchecked' }`.
  - `'without links or from, every step but the first is unlinked'`: → `source === 'none'`, `unlinked` has steps 2 and up.
  - `'counts changed steps below each node'`: S1→S2→S3, only S3 has homes → `root.changesBelow === 1`, S3 `changesBelow === 0`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/flow-map.test.ts`
Expected: FAIL, cannot find `../../src/web/flow-map.js`.

- [ ] **Step 3: Implement `buildFlowMap(flow: Flow): FlowMap` in `src/web/flow-map.ts`** following the rules above. Keep helpers private.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run test/web/flow-map.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/flow-map.ts test/web/flow-map.test.ts
git commit -m "feat: build a call tree model of a flow for the flow map"
```

---

### Task 2: The map component

**Files:**
- Create: `src/web/FlowMap.tsx`
- Modify: `src/web/styles.css` (new `.flow-map*` rules at the end of the tour-screen styles)
- Test: `test/web/flow-map-view.test.tsx`, `test/web/layout-css.test.ts`

**Interfaces:**
- Consumes: `buildFlowMap`, `FlowMap`, `MapNode`, `MapEdge` from Task 1.
- Produces:

```ts
export function FlowMap(props: {
  flow: Flow;
  /** The step being read: marked "you are here". */
  currentId: string;
  /** A box was clicked. */
  onOpenStep: (stepId: string) => void;
  /** An arrow was clicked: the calling step, its file and the calling line. */
  onOpenLine: (stepId: string, file: string, line: number) => void;
}): ReactNode;
```

What it draws (spec "What it shows" and "Big flows"):
- A key: "Blue edge: the step has changes" · "Dashed: no changes, here to show the flow" · "Orange outline: read closely" · "Arrow: this step calls the box below it, on that line" · "↻ Loop: these steps call each other in a circle". The loop line of the key shows only when the flow has a loop.
- A notice when `source === 'from'`: "The code check did not run for this flow. The arrows are the tour's own claims." When `'none'`: "The code check did not run. The steps are shown in order."
- The entry (`flow.entry.label`) at the top, then the tree as nested `<ul role="tree">` / `<li role="treeitem">` lists.
- A box is a `<button className="flow-map-box">` with: "Step N", the function name (`anchor.name`, else `symbol`, else nothing), the file's last two path parts, the step title, and tags: "N changes" (`homes.length`) or "no changes", "read closely", side effects with the outline's words (`db`, `event`, `ext`). Classes: `changed`, `unchanged`, `read-closely`; the current step gets `aria-current="step"` and a "You are here" tag.
- An arrow label above each non-root box is a `<button className="flow-map-edge">`: "line L", then "registers" / "request" / "event" for those `how`s, then "via X, Y" when `via` is set, then "✓ proven" (proven), nothing extra (name-match), "not found in the code" (not-found), "not checked" (unchecked). Unproven arrows get class `unproven` (dashed). Clicking calls `onOpenLine(edge.from, fromStep.file, edge.line)`.
- `alsoFrom` shows inside the box as small text: "Also called from step N, line L".
- Loops must be unmistakable (the user asked for this explicitly):
  - A box with `loopsFrom` or `loopsTo` gets a "↻ Loop" tag in the read-closely colour and the class `in-loop`.
  - Inside the called box, each `loopsFrom` edge is a button: "↻ Called again from step N, line L. Check that the loop stops." (for a step calling itself: "↻ Calls itself on line L. Check that it stops."). Clicking it calls `onOpenLine` with the caller and line.
  - Inside the calling box, each `loopsTo` edge reads "↻ Calls step N again on line L" (skipped for a self-call, which the line above already says).
  - Unproven loop edges add "(not found in the code)" or "(not checked)", like arrows.
- A node with children and `flow.steps.length > 12` and `changesBelow === 0` starts folded; a fold button reads "N steps below" (expanded: "Hide steps below"). Folding is component state per node id.
- Unlinked steps go in a final row titled "Not linked to the steps above".
- The panel scrolls inside itself: `.flow-map { overflow: auto; max-width: 100%; }`. Children of one box sit in a CSS grid of at most 4 columns (`grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))` inside a container capped at 4 × 220px plus gaps is fine; the builder may choose), so more than 4 wrap to a new row.

- [ ] **Step 1: Write the failing tests** in `test/web/flow-map-view.test.tsx` (render `FlowMap` directly):
  - `'shows each step as a box with number, name, file and tags'`: box for S2 has text "Step 2", "ChargeFee", "src/fees.ts", "3 changes", "read closely".
  - `'marks the current step'`: `currentId: 'S2'` → that box has `aria-current="step"` and text "You are here".
  - `'a box click opens the step; an arrow click opens the calling line'`: click box S3 → `onOpenStep('S3')`; click the arrow into S3 (link S2→S3 line 20) → `onOpenLine('S2', 'src/fees.ts', 20)`.
  - `'arrow labels say how the code check backs them up'`: proven with `via: ['buildContext']` → text "line 20", "via buildContext", "✓ proven"; a `not-found` link → "not found in the code" and class `unproven`.
  - `'without links it says the arrows are the tour own claims'` and `'without links or from it says the steps are shown in order'`: the notice texts above.
  - `'a long flow folds branches without changes'`: 14 steps, S2 has 3 unchanged steps below it → button "3 steps below"; clicking it shows those boxes.
  - `'unlinked steps are listed under their own heading'`: heading "Not linked to the steps above" with S3 under it.
  - `'a loop is marked on both boxes and in the key'`: links S1→S2, S2→S3, S3→S2 line 42 → S2 and S3 boxes have text "↻ Loop"; S2 has a button "↻ Called again from step 3, line 42. Check that the loop stops."; clicking it → `onOpenLine('S3', <S3 file>, 42)`; S3 has text "↻ Calls step 2 again on line 42"; the key has "↻ Loop: these steps call each other in a circle".
  - `'a step that calls itself says so'`: S2→S2 line 15 → S2 has "↻ Calls itself on line 15. Check that it stops."
  - `'no loop line in the key without loops'`: the key has no "↻ Loop" text.
- In `test/web/layout-css.test.ts`, add `'the flow map scrolls inside itself'`: `rule('.flow-map')['overflow']` is `'auto'`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/flow-map-view.test.tsx test/web/layout-css.test.ts`
Expected: FAIL, cannot find `../../src/web/FlowMap.js`, and no rule for `.flow-map`.

- [ ] **Step 3: Implement `FlowMap` in `src/web/FlowMap.tsx` and the `.flow-map*` styles.** Reuse the existing colour tokens (`--accent`, `--accent-soft`, `--border`, `--fg-muted`, and the read-closely colour the outline's `.rc-dot` uses). Look at the outline's `.dot` / `.dot-hollow` for the changed and unchanged styles so map and outline match.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run test/web/flow-map-view.test.tsx test/web/layout-css.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/FlowMap.tsx src/web/styles.css test/web/flow-map-view.test.tsx test/web/layout-css.test.ts
git commit -m "feat: draw a flow as a map of steps and calls"
```

---

### Task 3: Open the map from the tour

**Files:**
- Modify: `src/web/TourView.tsx` (state, keys, panel), `src/web/StepPane.tsx:208-214` (button next to `AboutFlow`), `src/web/StepPane.tsx` key hints line (`'j / k steps · [ ] flows · n / p changes · f whole file'`)
- Test: `test/web/tourview.test.tsx` (new `describe('flow map', ...)`)

**Interfaces:**
- Consumes: `FlowMap` from Task 2; existing `goTo(homeId)` and `openHome(homeId, at)` in `TourView`.
- Produces: `StepPane` prop `onOpenMap: () => void` (shown only for steps).

Behaviour:
- `TourView` keeps `const [mapOpen, setMapOpen] = useState(false)`. The map shows only while `mapOpen` and the current home is a step; it closes in `goTo` and whenever the current home is not a step.
- `StepPane` shows a "Flow map" button (title `withKey('Flow map', 'm')`) next to "About this flow"; it calls `onOpenMap`.
- Keys: `m` toggles the map when the current home is a step. `Escape` closes the map first; only when the map is closed does `Escape` go back from a followed call, as today.
- The panel: `<section className="flow-map-panel" role="dialog" aria-label={`Flow map: ${flow.title}`}>` rendered inside `.tour-main`, over the step pane, with a "Close" button.
- Box click: `goTo(stepId)` (closes the map). Arrow click: `openHome(stepId, { path: file, side: 'new', line })`, then close the map.
- Key hints line becomes `'j / k steps · [ ] flows · m map · n / p changes · f whole file'`.

- [ ] **Step 1: Write the failing tests** in `test/web/tourview.test.tsx`, `describe('flow map', ...)`, using the file's `makeTour` with a flow of 3 linked steps:
  - `'the Flow map button and m open the map of the current flow'`: on step 1, click "Flow map" → dialog "Flow map: <flow title>" is shown; press Escape → gone; press `m` → shown.
  - `'clicking a box goes to that step and closes the map'`: open, click the "Step 3" box → step trail reads "step 3 of 3", no dialog.
  - `'clicking an arrow opens the calling step at the calling line'`: open on step 3, click the arrow into step 3 (from step 2, line 20) → step trail reads "step 2 of 3", no dialog, and the code view got a reveal for line 20 (assert the same way the existing review-panel jump tests assert a reveal).
  - `'the map closes when the reader moves to a foundation'`: open the map, click the foundation in the outline → no dialog; press `m` there → still no dialog.
  - `'m in a text field types and does not open the map'`: focus a `<textarea>` (open the comment composer, or render one in the test) and fire `keyDown` `m` on it → no dialog.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/tourview.test.tsx -t "flow map"`
Expected: FAIL, no "Flow map" button.

- [ ] **Step 3: Implement the behaviour above** in `TourView.tsx` and `StepPane.tsx`. Update any test that asserts the key hints line.

- [ ] **Step 4: Run all web tests and see them pass**

Run: `npx vitest run test/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/TourView.tsx src/web/StepPane.tsx test/web/tourview.test.tsx
git commit -m "feat: open the flow map from the tour with a button or m"
```

---

### Task 4: Check on screen and open the PR

**Files:** none in the repo (screenshots go to a scratch folder outside the repo).

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: typecheck, lint, format and all tests pass.

- [ ] **Step 2: Build and start a separate pr-tour**

Run: `npm run build`, then `PR_TOUR_HOME=<scratch dir> PR_TOUR_PORT=4398 PR_TOUR_NO_OPEN=1 node dist/cli.js` with a copy of a tour database in the scratch dir (never `~/.pr-tour` itself).

- [ ] **Step 3: Look at the map in a browser** (Chrome extension, or headless Chrome screenshots) on three cases, at 1500 px and 900 px wide:
  - a short Go flow with a helper (`via`) arrow;
  - the longest flow available (15+ steps): folding works, no sideways page scroll;
  - a tour without links (or a flow whose links were removed in the scratch copy): the "tour's own claims" notice and dashed arrows.

Expected: boxes readable, arrows labelled, current step marked, clicks land on the right step and line. Fix what is off, re-run `npm run check`, commit.

- [ ] **Step 4: Push and open the PR** with a plain-English body (why, what changes, testing), no attribution footer. Merge only when the user says so.
