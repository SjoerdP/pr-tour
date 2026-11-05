# Flow map peek: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a box or arrow in a flow map opens a peek of that step's code below the map. Opening a step from the map is a visit you can come back from. Nothing from the map moves the reader's place or marks a step seen unless the reader asks.

**Architecture:** `CodeView` gets a read-only, keys-off mode. `FlowMap` gets a highlighted, auto-scrolled, auto-unfolded peeked box. A new `Peek` component shows one step's header and code. A new `MapWithPeek` component stacks map, divider and peek, and is controlled from outside. `TourView` owns the peek and visit state and routes every key, so key handling stays in one place.

**Tech Stack:** TypeScript, React 18, Vitest with Testing Library (jsdom), plain CSS in `src/web/styles.css`.

**Spec:** `docs/superpowers/specs/2026-11-05-flow-map-peek-design.md` (including its "Decisions made while reviewing this design" section, which binds).

## Global Constraints

- Plain English in UI copy: short sentences, common words.
- No real data from private repos in code, tests or commit messages: use the `acme/loans` example.
- Before the PR: `npm run check` passes. The Go checker is not touched. No server change.
- Commit messages are single-line conventional commits, with no Co-Authored-By line and no tool attribution.
- Check on screen with a separate pr-tour: `PR_TOUR_HOME=<scratch dir> PR_TOUR_PORT=4398 PR_TOUR_NO_OPEN=1 node dist/cli.js`. Never use `~/.pr-tour` for tests.
- Spec anti-goals:
  - Peeking, "Mark as seen", or a visit and return never change the tour's current step.
  - Nothing marks a step seen without the reader asking.
  - The peeked box never scrolls out of view.
  - The map never gets narrower when a peek opens.

## Review Focus

1. A reader walks the peek with `j` / `k` past the end of the flow, or into a folded branch. The peek stops at the ends, a folded branch unfolds, and the tour's place does not move. Tested in Tasks 2 and 5.
2. A visit, then a move on with `j`, then Esc. The visit has ended, so Esc does not jump back, and the visited step is marked seen when left, like any move. Tested in Task 5.
3. A visit, then the reader opens the map again with `m`, then "Open in tour" again. Back returns to the place before the first visit. Tested in Task 5.
4. Two code views are mounted (the step pane under the map, and the peek). `n`, `p` and `f` act only on the peek. Comment picking never happens in the peek. Tested in Tasks 1 and 5.
5. Local storage throws or holds rubbish. The divider falls back to its default without an error. Tested in Task 4.

---

### Task 1: A read-only, keys-off code view

**Files:**
- Modify: `src/web/CodeView.tsx`
- Test: `test/web/codeview.test.tsx`

**Interfaces:**
- Produces two new optional `CodeView` props:
  - `readOnly?: boolean`: no line-number buttons for comments and no composer. Existing threads and drafts still show.
  - `keys?: boolean` (default `true`): when `false`, `n`, `p` and `f` are not bound.

- [ ] **Step 1: Write failing tests:**
  - `'read-only shows no comment buttons on line numbers'`: no button named "Comment on line …".
  - `'keys off: n does not move to the next change'`: with two change blocks and `keys={false}`, `n` leaves the "change 1 of 2" label as it is.
- [ ] **Step 2: Run** `npx vitest run test/web/codeview.test.tsx` and expect them to FAIL.
- [ ] **Step 3: Implement.** Pass `onPick={null}` when `readOnly`. Bind keys only when `keys` is true: give `useKeys` an empty map when it is off.
- [ ] **Step 4: Run the tests** and expect them to PASS.
- [ ] **Step 5: Commit** `feat: let the code view be read-only and keyless`

---

### Task 2: The peeked box on the map

**Files:**
- Modify: `src/web/FlowMap.tsx`, `src/web/styles.css`
- Test: `test/web/flow-map-view.test.tsx`

**Interfaces:**
- Produces a new optional `FlowMap` prop, `peekedId?: string | null`. The box of that step:
  - gets the class `peeked` and the text "Peeking";
  - is scrolled into view (`scrollIntoView({ block: 'nearest', inline: 'center' })`, guarded for jsdom) whenever `peekedId` changes;
  - has every folded branch that holds it opened.

- [ ] **Step 1: Write failing tests:**
  - `'marks the peeked box'`: class and "Peeking" text.
  - `'opens a folded branch that holds the peeked step'`: a 14-step flow where step 5 sits in a folded branch, with `peekedId='S5'`, shows the Step 5 box.
  - `'scrolls the peeked box into view when it changes'`: spy on `Element.prototype.scrollIntoView`, rerender with another `peekedId`, and expect a call.
- [ ] **Step 2: Run them** and expect FAIL.
- [ ] **Step 3: Implement.** The fold rule becomes "starts open" OR "holds the peeked step". The reader's own fold choice still wins for branches that do not hold the peeked step. The highlight is a 3px `--accent` ring plus `--accent-soft` background, distinct from "You are here".
- [ ] **Step 4: Run them** and expect PASS.
- [ ] **Step 5: Commit** `feat: highlight, unfold and scroll to the peeked step in the flow map`

---

### Task 3: The peek

**Files:**
- Modify: `src/web/StepPane.tsx`: export `codeTarget`, and the "Called from" facts if you reuse them.
- Create: `src/web/Peek.tsx`
- Modify: `src/web/styles.css`
- Test: `test/web/peek.test.tsx`

**Interfaces:**
- Consumes: `CodeView` with `readOnly` and `keys` (Task 1); `cameFrom(flow, step)` from `homes.ts`; `codeTarget`.
- Produces:

```ts
export function Peek(props: {
  repo: string;
  pr: number;
  tour: Tour;
  flow: Flow;
  stepId: string;
  /** A calling line to bring into view and flash; null for the step's start. */
  line: number | null;
  seen: boolean;
  /** CodeView's keys: true only for the peek that should answer n / p / f. */
  keys: boolean;
  review: ReviewState;
  onMove: (stepId: string, line: number | null) => void;
  onMarkSeen: (stepId: string) => void;
  onOpenInTour: (stepId: string) => void;
  onClose: () => void;
}): ReactNode;
```

What it shows (spec "The peek"):
- the trail "Flow N · step S of T", plus "called from step C, line L ✓" when `cameFrom` gives one, using the same proof words as the step pane;
- the title, then tags: "read closely", "N changes" or "no changes", side effects, and "seen" or "not seen yet";
- the read-closely reason;
- the buttons "Open in tour ↗", "Mark as seen" (hidden when `seen`) and "Close" (title `withKey('Close', 'Esc')`);
- the code: `CodeView readOnly` with `keys` passed through, `homeId=stepId`, the step's `codeTarget`, and `reveal` at `line` when set;
- the CodeView's `onJump` with a `toStep` in this flow calls `onMove(toStep, null)`. Other calls do nothing. Its `onNextStep` (the next-step badge) calls `onMove(nextStepId, null)`.

- [ ] **Step 1: Write failing tests:** with the trail, tags and reason; with buttons calling their handlers; with "Mark as seen" hidden when seen; with a "→ step N" badge click calling `onMove`; and with no comment buttons. Mock `CodeView`'s file loading, as the other tests do.
- [ ] **Step 2: Run them** and expect FAIL.
- [ ] **Step 3: Implement** `Peek` and its styles.
- [ ] **Step 4: Run them** and expect PASS.
- [ ] **Step 5: Commit** `feat: add a peek that shows one step's code`

---

### Task 4: Map with peek

**Files:**
- Create: `src/web/MapWithPeek.tsx`
- Modify: `src/web/styles.css`
- Test: `test/web/map-with-peek.test.tsx`

**Interfaces:**
- Consumes: `FlowMap` with `peekedId` (Task 2) and `Peek` (Task 3).
- Produces:

```ts
export type PeekState = { flowId: string; stepId: string; line: number | null };

export function MapWithPeek(props: {
  /** 'panel': fills the map panel and splits its height; 'card': inside an overview card. */
  place: 'panel' | 'card';
  flow: Flow;
  currentId: string;
  peek: PeekState | null; // only when peek.flowId === flow.id is it shown here
  /** Everything Peek needs that is not about the step: repo, pr, tour, review, isSeen, keys. */
  peekProps: Omit<Parameters<typeof Peek>[0], 'flow' | 'stepId' | 'line' | 'seen' | 'onMove' | 'onClose'> & {
    isSeen: (id: string) => boolean;
  };
  onPeek: (peek: PeekState | null) => void;
}): ReactNode;
```

Behaviour:
- A box click calls `onPeek({ flowId, stepId, line: null })`. An arrow click, or a loop or "also called" line, calls `onPeek({ flowId, stepId: callerId, line })`.
- With a peek, the map sits on top, then a divider (`role="separator"`, `aria-orientation="horizontal"`, draggable with pointer events, and moved with the arrow keys when focused), then `Peek`.
- In `'panel'` the divider sets the map's share of the height (default 0.4, clamped 0.15–0.85).
- In `'card'` the map is capped at 300px tall and the peek gets the remembered height (default 60vh).
- Both values are stored under `pr-tour.peek-split` in local storage, wrapped in try/catch. Bad values fall back to the defaults.
- Below 800px (CSS), the peek covers the map and shows a "← Map" button that calls `onPeek(null)`.

- [ ] **Step 1: Write failing tests:**
  - a box click calls `onPeek` with that step;
  - an arrow click calls it with the caller and the line;
  - with a `peek` the map and the peek both show, and the divider is a separator;
  - a peek of another flow is not shown here;
  - local storage that throws, or holds `"x"`, still renders with the defaults.
- [ ] **Step 2: Run them** and expect FAIL.
- [ ] **Step 3: Implement** it, with its styles.
- [ ] **Step 4: Run them** and expect PASS.
- [ ] **Step 5: Commit** `feat: stack the flow map and a peek with a divider`

---

### Task 5: Peek and visits in the tour

**Files:**
- Modify: `src/web/TourView.tsx`, `src/web/Overview.tsx`, `src/web/StepPane.tsx` (the back button), `src/web/styles.css`
- Test: `test/web/tourview.test.tsx` (a new `describe('peek and visits', ...)`), `test/web/overview.test.tsx`

**Interfaces:**
- Consumes: `MapWithPeek` and `PeekState` (Task 4); the existing `goTo`, `openHome`, `markLeft`, `isSeen`, `overviewOpen`, `mapOpen`, and the tour-key reset.
- Produces:
  - `TourView` state: `peek: PeekState | null`, and `visit: { back: 'map' | 'overview'; place: string; peek: PeekState | null } | null`, where `place` is the current home before the first visit.
  - A `StepPane` prop `back?: { label: string; go: () => void }`. It shows "← Back to the map" or "← Back to the overview" at the top of the step.
  - `Overview` takes `peek`, `onPeek`, `peekProps` and `onVisit(stepId)` in place of `onOpenHome` / `onOpenLine` for maps, the strip and "Also in this PR".

Behaviour (spec "Seen marks and the reader's place" and "Decisions"):
- The map panel and the overview render `MapWithPeek`. On the overview only one peek shows at a time, because state is a single `peek`.
- Keys, routed only here:
  - With a peek open: `j` / `k` move the peek along the flow's steps (they stop at the ends), Esc closes the peek, and `n` / `p` / `f` go to the peek (`keys` true only for the peek).
  - Map panel, no peek: `j` / `k` open a peek of the current step.
  - Overview, no peek: keep today's behaviour.
  - The step pane's `CodeView` gets `keys={false}` while the map panel or the overview is shown.
- "Mark as seen" calls `markLeft(stepId)`. It does not change `currentId`.
- "Open in tour" sets `visit` and shows that step without `markLeft`:
  - If no visit is active, `visit.place` becomes the current home.
  - If a visit is active, `visit.place` stays the same, and `back` and `peek` are updated.
  - The map panel or the overview stays mounted but `hidden` during the visit, so cards, folds and scroll come back as they were.
- Back (the button, or Esc when nothing else uses Esc) restores `currentId = visit.place`, reopens the map or overview, restores `peek`, clears `visit`, and marks nothing.
- Any real move ends the visit: `goTo` to another home (`j`, `k`, `[`, `]`, outline, call or badge follow, review-panel jump, "belongs to"). Leaving the visited step then marks it seen, like any move.
- The overview's strip and "Also in this PR" open steps as visits with `back: 'overview'`.

- [ ] **Step 1: Write failing tests** in `describe('peek and visits')`:
  - `'a box click in the map panel opens a peek and leaves the tour where it was'`: the code view trail is unchanged and `markSeen` is not called.
  - `'j and k move the peek, not the tour, and stop at the ends'`.
  - `'Esc closes the peek, a second Esc closes the map'`.
  - `'Mark as seen marks the peeked step without moving the tour'`.
  - `'Open in tour visits the step; Back returns to the map with the same peek and the old place, marking nothing'`.
  - `'moving on from a visited step ends the visit and marks it when left'`.
  - `'a second Open in tour during a visit still returns to the place before the first visit'` (Review Focus 3).
  - `'n acts on the peek, not on the step pane under the map'`.
  - `'on the overview, a strip click is a visit with Back to the overview'`, and `'opening a peek in one card closes the peek in another'`.
- [ ] **Step 2: Run** `npx vitest run test/web/tourview.test.tsx -t "peek and visits"` and expect FAIL.
- [ ] **Step 3: Implement.** Update the existing tests that clicked map boxes expecting to move the tour, keeping what they check (the move now happens through "Open in tour").
- [ ] **Step 4: Run** `npx vitest run test/web` and expect PASS.
- [ ] **Step 5: Commit** `feat: peek into steps from the flow map and come back from visits`

---

### Task 6: Check on screen and open the PR

- [ ] **Step 1:** Run `npm run check`. Expect all checks to pass.
- [ ] **Step 2:** Run `npm run build`. Start a separate pr-tour with a copy of a tour database in a scratch folder.
- [ ] **Step 3:** At 1500px and 900px, check:
  - peeking from the map panel and from an overview card;
  - walking with `j` / `k` through a wide, 11-step flow and a folded 20-step flow;
  - dragging the divider and reloading (the split is remembered);
  - Open in tour, then Back.

  Expected: the peeked box stays in view and the code is readable. Fix what is off, then commit.
- [ ] **Step 4:** Push, then open the PR with a plain-English body. Merge only when the user says so.
