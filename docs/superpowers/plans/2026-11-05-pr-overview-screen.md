# PR overview screen: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PR opens on an overview (what it does, its flows with their maps, the rest) before the step-by-step tour; the overview is always one button or key away.

**Architecture:** A pure helper decides where a PR opens (`src/web/homes.ts`). A new `Overview` component (`src/web/Overview.tsx`) draws the screen and reuses `FlowMap` for each flow. `TourView` shows the overview in `.tour-main` instead of the step pane while it is open; `TopBar` gets an Overview button. No server change.

**Tech Stack:** TypeScript, React 19, Vitest with Testing Library (jsdom), plain CSS in `src/web/styles.css`.

**Spec:** `docs/superpowers/specs/2026-11-05-pr-overview-and-flow-map-design.md` (sections "The overview screen" and "Navigation"). This plan is PR 2 of 3. "Things to check" (section 2 of the screen), its fallback from read-closely steps, ticks and pins are PR 3 and stay out of this plan.

## Global Constraints

- Plain English in UI copy: short sentences, common words.
- No real data from private repos in code, tests or commit messages: use the `acme/loans` example.
- Before the PR: `npm run check` passes (typecheck, lint, format, tests). The Go checker is not touched.
- Commit messages: single line, conventional, no Co-Authored-By line, no tool attribution.
- Check on screen with a separate pr-tour: `PR_TOUR_HOME=<scratch dir> PR_TOUR_PORT=4398 PR_TOUR_NO_OPEN=1 node dist/cli.js`. Never use `~/.pr-tour`. Real-PR screenshots stay outside the repo.
- Spec anti-goal: "An overview that is slower to get past than today's tour: one click or key starts the tour, and a reader who already started lands where they were."

## Review Focus

1. A tour with no flows (only foundations or other changes): the overview shows no flows section and "Start the tour" still works. Tested in Task 2.
2. A reader who saw everything: the PR opens on the first home, not on the overview and not on nothing. Tested in Task 1 and Task 3.
3. A tour whose seen marks are all outdated (new commits changed every home): it opens on the overview again, as for a new reader. Tested in Task 1.
4. A flow of 20+ steps: the step strip wraps and the page never scrolls sideways. Tested in Task 2 (layout CSS contract) and on screen in Task 4.
5. Pressing `o` while typing a comment types an "o" (`useKeys` ignores text fields). Tested in Task 3.

---

### Task 1: Where a PR opens

**Files:**
- Modify: `src/web/homes.ts`
- Test: `test/web/homes.test.ts`

**Interfaces:**
- Produces:

```ts
/**
 * Where a PR opens: the overview for a reader who has seen nothing of this tour yet,
 * else the first home not seen (the first home when all are seen).
 */
export function openingPlace(
  homes: Home[],
  isSeen: (homeId: string) => boolean,
): { overview: true; homeId: string | null } | { overview: false; homeId: string };
```

With `overview: true`, `homeId` is the first home (or null for a tour with no homes): the place "Start the tour" goes.

- [ ] **Step 1: Write the failing tests** in `test/web/homes.test.ts`, `describe('openingPlace', ...)`, using the file's existing tour fixture:
  - `'opens on the overview when nothing is seen'` → `{ overview: true, homeId: <first home id> }`.
  - `'opens on the first home not seen once the reader started'`: first two homes seen → `{ overview: false, homeId: <third home id> }`.
  - `'opens on the first home when everything is seen'` → `{ overview: false, homeId: <first home id> }`.
  - `'a tour without homes opens on the overview'` → `{ overview: true, homeId: null }`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/homes.test.ts -t openingPlace`
Expected: FAIL, `openingPlace` is not exported.

- [ ] **Step 3: Implement `openingPlace`** in `src/web/homes.ts`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run test/web/homes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/homes.ts test/web/homes.test.ts
git commit -m "feat: decide whether a PR opens on the overview or the tour"
```

---

### Task 2: The overview component

**Files:**
- Create: `src/web/Overview.tsx`
- Modify: `src/web/styles.css` (new `.overview*` rules)
- Test: `test/web/overview.test.tsx`, `test/web/layout-css.test.ts`

**Interfaces:**
- Consumes: `FlowMap` from `src/web/FlowMap.tsx` (`{ flow, currentId, onOpenStep, onOpenLine }`); `otherGroupsInOrder` from `src/web/homes.ts`; `Tour`, `Flow` from `src/shared/tour.ts`.
- Produces:

```ts
export function Overview(props: {
  tour: Tour;
  /** The PR title, shown as the overview's title. */
  title: string;
  /** True once the reader has seen any home: the start button says "Continue the tour". */
  started: boolean;
  /** The home the tour is on (marked in the maps); null before the reader started. */
  currentId: string | null;
  onStart: () => void;
  onOpenHome: (homeId: string) => void;
  onOpenLine: (homeId: string, file: string, line: number) => void;
}): ReactNode;
```

What it draws, top to bottom (spec "The overview screen", without things to check):
- `<h2>` with `title`, then the tour's `summary` as a paragraph.
- A "Start the tour" button (`started`: "Continue the tour"), class `primary`, at the top right of the title row **and** again at the bottom of the screen. Both call `onStart`.
- "Flows in this PR (N)" as `<h3>`, left out when the tour has no flows. One card per flow, in tour order:
  - "Flow N · <title>", the entry label in monospace, and the flow's `why` when present.
  - Counts: "S steps · C changed · R read closely" (changed = steps with homes; drop the "read closely" part when R is 0).
  - The step strip: one button per step, "N <title>", with classes `changed` / `unchanged` / `read-closely` (same look as the map's boxes); a click calls `onOpenHome(step.id)`. The strip wraps.
  - A toggle button "Show the map" / "Hide the map" (`aria-expanded`). The first flow's map is open by default, the others shut. The map is `FlowMap` with `currentId ?? ''`, `onOpenStep = onOpenHome`, `onOpenLine` passed through.
- "Also in this PR" as one line, left out when there is nothing: foundations ("2 foundations", linking to the first foundation), then each other-changes group by its title with its item count ("Tests (3)", linking to its first item), in `otherGroupsInOrder` order. Each part is a link-style button calling `onOpenHome`.
- The screen scrolls inside `.tour-main`; it never makes the page scroll sideways.

- [ ] **Step 1: Write the failing tests** in `test/web/overview.test.tsx` (render `Overview` directly; tour data on the `acme/loans` theme):
  - `'shows the title, the summary and a start button'`: title and summary text present; clicking "Start the tour" (either one) calls `onStart`.
  - `'says Continue the tour once started'`.
  - `'lists each flow with its entry, why, counts and steps'`: "Flow 1 · Repay a loan", "POST /loans/{id}/repay", the why text, "5 steps · 3 changed · 1 read closely", and step buttons "1 Parse the request" etc.; clicking a step button calls `onOpenHome('F1.S1')`.
  - `'opens the first flow map and toggles the others'`: the first flow shows a "Flow 1 map" region (give `FlowMap` a wrapper with `aria-label` "Flow N map"), the second does not; clicking "Show the map" on the second shows it.
  - `'a map click opens the step'`: clicking a box in the open map calls `onOpenHome` with that step id.
  - `'lists the rest of the PR'`: "Also in this PR" with "1 foundation" and "Tests (1)"; clicking "Tests (1)" calls `onOpenHome('o1.1')`.
  - `'a tour without flows has no flows section and can still start'`.
- In `test/web/layout-css.test.ts`: `'the overview step strip wraps'`: `rule('.overview-strip')['flex-wrap']` is `'wrap'`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/overview.test.tsx test/web/layout-css.test.ts`
Expected: FAIL, cannot find `../../src/web/Overview.js`; no rule for `.overview-strip`.

- [ ] **Step 3: Implement `Overview` and its styles.** Reuse the map's box colours for the strip (same tokens as `.flow-map-box.changed` etc.) so both read the same.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run test/web/overview.test.tsx test/web/layout-css.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/Overview.tsx src/web/styles.css test/web/overview.test.tsx test/web/layout-css.test.ts
git commit -m "feat: add a PR overview with flows, maps and the rest"
```

---

### Task 3: Open the overview first, and always reach it

**Files:**
- Modify: `src/web/TourView.tsx`, `src/web/TopBar.tsx`
- Test: `test/web/tourview.test.tsx` (new `describe('overview', ...)`); update existing TourView tests that expect the first step on load (they now land on the overview: start the tour in their setup, or give them seen marks)

**Interfaces:**
- Consumes: `openingPlace` (Task 1), `Overview` (Task 2).
- Produces: `TopBar` prop `onOverview: () => void` and `overviewOpen: boolean`.

Behaviour:
- When a tour first loads (and again after a rebuild swaps it, using the same tour key the map uses), `TourView` takes `openingPlace(homes, isSeen)` once: it sets whether the overview is open and the current home. Later changes to seen marks do not move the reader.
- While the overview is open, `.tour-main` shows `Overview` instead of `StepPane`; the outline stays.
- "Start the tour" / "Continue the tour" closes the overview and shows the current home.
- Anything that opens a home closes the overview: an outline click, a click in the overview, `openHome` from the review panel, `j` / `k` / `[` / `]` (`j` and `k` first close the overview and show the current home without moving; `[` and `]` move as today).
- The top bar gets an "Overview" button (title `withKey('Overview', 'o')`, `aria-pressed={overviewOpen}`) before "About this PR". Key `o` toggles the overview. `Escape` closes it when nothing else (map, jump) uses Escape.
- The flow map panel and the overview are never open at once: opening the overview closes the map.
- Key hints line in `StepPane` becomes `'j / k steps · [ ] flows · m map · o overview · n / p changes · f whole file'`.

- [ ] **Step 1: Write the failing tests** in `test/web/tourview.test.tsx`, `describe('overview', ...)`:
  - `'a PR the reader has not started opens on the overview'`: no seen marks → the overview title is shown and no step pane (`step-trail` absent).
  - `'Start the tour shows the first home'` → step trail of the first home, overview gone.
  - `'a started PR opens on the first home not seen'`: seen marks for the first two homes → trail of the third home, no overview.
  - `'everything seen opens on the first home'`.
  - `'the Overview button and o open the overview; Start goes back to where the reader was'`: start, press `j` twice, press `o` → overview; click "Continue the tour" → the same home as before.
  - `'j on the overview shows the current home without moving'`.
  - `'an outline click closes the overview and opens that home'`.
  - `'opening the overview closes the flow map'`.
  - `'o in a text field types and does not open the overview'`.
- Update the existing tests that assume the first home on load.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/tourview.test.tsx -t overview`
Expected: FAIL, no overview.

- [ ] **Step 3: Implement the behaviour above** in `TourView.tsx` and `TopBar.tsx`; update the key hints line and any test asserting it.

- [ ] **Step 4: Run all web tests and see them pass**

Run: `npx vitest run test/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/TourView.tsx src/web/TopBar.tsx src/web/StepPane.tsx test/web
git commit -m "feat: open a new PR on its overview and add an Overview button"
```

---

### Task 4: Check on screen and open the PR

**Files:** none in the repo (screenshots go to a scratch folder outside the repo).

- [ ] **Step 1: Run the full check.** Run: `npm run check`. Expected: all pass.
- [ ] **Step 2: Build and start a separate pr-tour** (`npm run build`, then the command in Global Constraints) with a copy of a tour database in a scratch dir, with the seen marks cleared for one PR so it opens on the overview.
- [ ] **Step 3: Look at it in a browser** at 1500 px and 900 px: a one-flow PR, a PR with 4+ flows, a PR with a 20-step flow. Expected: the overview reads top to bottom, the first map is open, the strip wraps, Start lands on the first home, `o` returns, a started PR opens where the reader was. Fix what is off, re-run `npm run check`, commit.
- [ ] **Step 4: Push and open the PR** with a plain-English body (why, what changes, testing), no attribution footer. Merge only when the user says so.
