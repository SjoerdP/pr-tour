# PR overview and flow map: design

Date: 2026-11-05. Status: draft for review.

## Why

A reviewer opening a PR in pr-tour lands straight on the first step. They see code before
they know what the PR does, which flows it touches, or where the risk is. Using pr-tour on a
real PR showed three gaps:

- There is no place that says "this is what the PR does, and this is what to check".
  "Read closely" marks exist per step, but they are spread over the outline.
- A step can be reached through a helper that is not a step. The step pane says so in
  small text ("Called from step 2, through `buildContext`"), but the reviewer has no picture
  of how the steps call each other.
- Outline and step pane did not agree on numbers and counts (fixed separately on
  `feat/outline-step-count`).

The goal of pr-tour is to be the best review tool there is. For this part that means:

- The reviewer understands what the PR does and which flows it touches in about 30 seconds,
  before reading code.
- The critical points are listed up front as questions to answer, each linked to the code.
- Each flow can be seen as a map: which step calls which, on which line, through which
  helper, and what the code check proved.
- The reviewer never has to wonder "where is this file and what does it do".

## Goals

1. An overview screen per PR: what it does, things to check, the flows, the rest.
2. "Things to check": a short list of questions for the whole PR. Each links to one or
   more places in the tour. The reviewer ticks them off by hand.
3. A flow map per flow: one box per step, one arrow per call, built from the code check's
   links. Click a box to open that step; click an arrow to open the calling step at the
   calling line.
4. The same map inside the tour, for the current flow, with the current step marked
   ("you are here").
5. The overview opens first for a PR the reader has not started. It is always one click
   or one key away.

## Non-goals (for now)

- Code inside the map. The step view is where code is read. A hover preview of a few
  lines may come later.
- A sequence diagram, phases, lanes or a "whole phase" reading mode. The 2026-10-29 spike
  (`docs/superpowers/ideas/2026-10-29-flow-map-spike.md`) leaned to a sequence diagram; the
  2026-11-05 mockups chose boxes and arrows (a call tree), which reads faster for most
  flows. A sequence view can come later on the same data.
- Making progress counts configurable.
- The demo tour and step-through (backlog, comes after this).
- Sharing ticks or seen marks with a team. Ticks are local, like seen marks.

## Anti-goals (a failure even if it works)

- A map that shows Claude's claim as proven. Arrows come from proven or name-matched
  links only; a link only Claude claims is drawn as unproven or not at all (see below).
- A "thing to check" that links to a place that does not exist.
- An overview that is slower to get past than today's tour: one click or key starts the
  tour, and a reader who already started lands where they were.
- A map that is unreadable for a real flow. Flows of 20 or more steps exist; the map must
  stay usable for them (see "Big flows").
- Ticking a point counted as "seen", or seeing a step counted as ticking its point.

## The overview screen

Top to bottom:

1. **Title and summary.** The PR title and the tour's `summary`, in plain words. (Builder's
   call: a tour has no title field of its own.)
2. **Things to check.** The list, numbered. Each point:
   - a question in one sentence ("Is the fee charged before the repayment is stored?");
   - an optional one-line reason (why it matters);
   - one or more links to places, written in full: "Flow 2 · step 3 · `ChargeFee`",
     "Foundation · migration `add_fee_column`", or a file under other changes;
   - a tick box. Ticked points stay in the list, dimmed.
3. **Flows in this PR.** One card per flow, in tour order: number and title, the entry
   (for example `POST /loans/{id}/repay`), counts ("6 steps · 4 changed · 2 read closely"),
   and the step strip (numbered steps; filled when changed, dashed when not, outlined when
   read closely). A card opens to show its map. The first flow is open by default.
4. **The rest.** One quiet line: foundations, tests, docs, generated code, with counts.
   Each part links into the tour.
5. **Start the tour** (or **Continue the tour** when the reader has started).

## Things to check

### Where they come from

Claude writes them as part of the tour, as a new top-level field next to `summary`:

```json
"checks": [
  {
    "question": "Is the fee charged before the repayment is stored?",
    "why": "A failed charge after the insert leaves a repayment without a fee.",
    "places": [{ "flow": 1, "step": 3 }, { "foundation": 1 }]
  }
]
```

- A place names a flow step (`flow` and `step`, 1-based, as Claude's output has no ids),
  a foundation (1-based), or an other-changes file (`file`).
- The prompt asks for at most 5 checks, the ones a careful reviewer must answer before
  approving. A PR with nothing critical has none.
- The builder turns places into home ids, like it does for `from`. A place that names no
  real step, foundation or file is dropped and reported as a check problem. A check left
  with no places is kept without links (the question still matters).
- The existing per-step `risk` and `riskReason` stay. The outline and step pane keep using
  them.
- Tours built before this have no `checks`. Their overview shows "Things to check" built
  from the read-closely steps and their `riskReason`, linked to those steps, so old tours
  still get a useful list. It says that it was built from the read-closely marks.

### Ticking

- The reader ticks a point by hand. Ticks are stored like seen marks: per repo, PR and
  check, in the local database.
- A tick holds while the places it links to keep their content hash. When one of them
  changes (new commits, rebuilt tour), the tick is cleared, as a seen mark would be.
  Checks are matched across rebuilds by their question text; a reworded question is a new
  check.
- Approving with open checks lists them in the approve reminder, above the unseen items.
  Approving anyway stays possible.

### Pins

A point's number shows as a small pin on each map box it links to, and next to the step in
the outline. Clicking a pin scrolls to the point in the list (overview) or shows it in a
small popover (tour).

## The flow map

### What it shows

- **The entry** at the top: the flow's `entry.label` (an HTTP route, a job, an event).
- **One box per step.** Step number, function name (the anchor name, else the symbol, else
  the title), the file (short path), the step title as the one-line purpose, and tags:
  number of changed parts, "no changes", "read closely", side effects, and pins.
  Box styles match the outline: blue edge for changed, dashed for no changes, orange
  outline for read closely. A key above the map explains them.
- **One arrow per link** between steps, from the flow's `links`. Its label: the calling
  line, how ("calls", "registers", "request", "event"), the helpers in between ("via
  `buildContext`"), and ✓ when proven. Name-matched links are drawn plain. Links only
  Claude claims are drawn dashed: "not found in the code" when the check looked and did not
  find it, "not checked" when the check did not run for it.
- **Without code-check links** (the checker did not run: a non-Go repo, or Go is missing),
  the arrows come from each step's `from`, all dashed and marked "not checked". A tour
  with neither `links` nor `from` (very old tours) shows the steps in order, unlinked, and
  says the code check did not run. (Design call: this keeps the map useful outside Go.)
- **Layout.** A tree from the entry: each step under the step that calls it. Several calls
  from one step sit side by side, left to right in the order of their calling lines.
- A step reached from two steps sits under one caller, picked in this order: a proven
  link, then a name-matched link, then a Claude-only link; on a tie, the lowest step
  number. The other links are thinner arrows to it. So the tree's shape never follows an
  unproven claim over a proven one.
- A step with no incoming link sits under the entry, in a "not linked" row, so it is never
  lost.

### Clicking

- A box opens that step in the tour.
- An arrow opens the calling step, scrolled to the calling line, with that line marked.
- In the tour, the map marks the current step.

### Big flows

- A box shows title and tags on one line each; long names are cut with a tooltip.
- More than 4 calls from one step wrap to a second row.
- The map scrolls inside its card; it never makes the page scroll sideways.
- Branches can be folded at a box ("3 steps below"). Branches with no changes below them
  start folded when the flow has more than 12 steps.

## Navigation

- Opening a PR the reader has not started (no seen marks for its current tour) shows the
  overview. Otherwise the tour opens on the first home not seen yet (the first home when
  all are seen). This needs no new storage: it follows from the seen marks. Today the tour
  always opens on the first home. (Design call: remembering the exact last place would need
  new storage for little gain.)
- The top bar gets an **Overview** button; the key `o` opens it too.
- In the tour, a **Flow map** button next to "About this flow" (key `m`) opens the current
  flow's map in a panel over the code. Esc closes it.
- The URL stays `/pr/<owner>/<repo>/<n>`; the overview is a view inside the tour page, not
  a new route.

## Constraints

- Plain English in the UI and docs; short sentences.
- No real data from private repos in this repo: use the `acme/loans` example in tests,
  docs and fixtures.
- Quality first: the new prompt part must not make tours worse. Before the checks PR is
  merged (after it is built and its tests pass), run at least 3 builds on the same commit
  without the change and 3 with it (see the build benchmark):
  - Counted: check problems, proven links, side fixes. The merge is blocked when these get
    worse by more than the normal spread between builds.
  - Judged by hand: a table with each build's checks side by side; the user marks each as
    useful, obvious or wrong, and decides.
  - The map and overview PRs do not change the prompt, so they need only the usual tests
    and a look on screen.
- The map is built in the web app from the stored tour; no new server work for drawing.
- Works for tours from before this change (no `checks`, possibly no `links`); see "Without
  code-check links" above.
- The author-mode `/tour` skill (`skill/tour/SKILL.md`, copied to `~/.claude/skills/tour`)
  is updated to write `checks` too, so author tours get real checks, not only the fallback.

## Left to the builder

- How the map is drawn (HTML and CSS boxes, or SVG), as long as it meets the layout rules
  above and works at narrow widths.
- The exact look of pins, ticks and the key.
- How ticks are stored (a new table or a column), within the rules above.
- Splitting the work into PRs. A sensible order: map in the tour, then the overview
  without checks, then checks.
