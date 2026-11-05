# Flow map peek: design

Date: 2026-11-05. Status: draft for review. Builds on
`2026-11-05-pr-overview-and-flow-map-design.md` (the flow map and the overview are merged).

## Why

Today a click on a box or an arrow in the flow map leaves the map: the tour moves to that step
and the map closes. Reading one step's code costs the reader the map, their scroll position in
it, and their place in the tour. The way back (`m`, `o`) is hidden. Readers want to read code
while they keep the flow in view.

Flow maps are wide (many calls side by side) and shallow (2 to 4 levels), so the code goes
below the map, not beside it.

## Goals

1. A click on a box opens a **peek** of that step: its changed code, below the map, in the same
   panel. A click on an arrow peeks the calling step, scrolled to the calling line.
2. The map stays visible above the peek, keeps its full width, marks the peeked box, and
   scrolls itself so the peeked box is in view.
3. `j` / `k` move the peek to the next / previous step of the flow. Esc closes the peek and
   gives the map its full height back.
4. Nothing done from the map moves the reader's place in the tour or marks a step seen,
   unless the reader asks for it.
5. "Open in tour" is a visit with a way back to exactly where the reader was.

## Non-goals

- Commenting in the peek. "Open in tour" is the way to comment.
- A peek for foundations or other changes (they are not on the map).
- A peek of callees that are not steps.

## Anti-goals (a failure even if it works)

- The tour's current step changes because the reader peeked, marked a step seen from the peek,
  or opened a step from the map and came back.
- A peek or a visit marks a step seen without the reader pressing "Mark as seen".
- The peeked box scrolls out of view while the reader walks the flow with `j` / `k`.
- The map gets narrower when a peek is open.

## The peek

Where: inside the flow map panel (`m`) and inside each flow card's map on the overview. The
area splits into the map on top and the peek below, with a divider the reader can drag. The
split is remembered per browser (local storage; a failure to read or write it falls back to
the default, map 40% and peek 60%).

Header, top to bottom:

- The trail: "Flow N · step S of T", then "called from step C, line L ✓" (the same facts and
  proof words as the step pane's "Called from", from the same helper).
- The step title, then its tags: "read closely", the number of changes or "no changes", side
  effects, "seen" or "not seen yet".
- The read-closely reason when there is one.
- Buttons: "Open in tour ↗", "Mark as seen" (hidden when the step is seen), and a close
  button (Esc).

Body: the step's code as the tour shows it (the same code view: diff, colours, folded
unchanged code, the "→ step N" badges), scrollable, read-only (no comment picking). A peek
opened from an arrow brings the calling line into view and flashes it, as the review panel's
jumps do.

Inside the peek:

- A "→ step N" badge or a call into another step of the same flow moves the peek to that step.
- Other calls do nothing in the peek.
- `j` / `k` move the peek along the flow's step order; at the ends they do nothing.
- Esc closes the peek. A second Esc closes the map panel, as today.

On the map: the peeked box gets a clear highlight (distinct from "You are here"), and the map
scrolls so it is in view, centred where possible, whenever the peek moves.

## Seen marks and the reader's place

- Peeking never marks a step seen and never changes the tour's current step.
- "Mark as seen" marks the peeked step seen at its current content hash, the same mark the tour
  makes. It does not move the tour.
- "Open in tour" is a visit:
  - It shows that step in the tour (map and overview close) and remembers where the reader came
    from: the tour's previous current step, and the map or overview with its open peek.
  - The step pane shows "← Back to the map" (or "← Back to the overview"). Esc does the same
    when nothing else uses Esc.
  - Going back restores the previous current step and reopens the map or overview with the same
    peek. The visit marks nothing seen.
  - If the reader moves on from the visited step (`j`, `k`, an outline click, `[` / `]`), the
    visit ends: the visited step is the reader's place now, the back button goes away, and
    leaving the visited step marks it seen like any move.
- The existing click behaviour that left the map (box → step, arrow → calling line) is
  replaced by the peek. The step strip on the overview keeps going straight into the tour, as
  a visit with the same way back.

## Decisions made while reviewing this design (designer's calls)

- **One peek at a time.** On the overview, opening a peek in one flow card closes a peek in
  another. Inside a card, the map keeps at most 300 px of height (it scrolls inside) and the
  peek gets a fixed height of 60% of the window, which the divider changes and the browser
  remembers. In the map panel the divider splits the panel's height (default 40 / 60).
- **"Exactly where the reader was."** During a visit the map panel or the overview stays
  mounted but hidden, so everything comes back as it was: which cards and maps are open,
  folds, the peek, and every scroll position.
- **Keys while the map or overview is open.** The tour's place never moves from there.
  - With a peek open: `j` / `k` move the peek; Esc closes the peek.
  - Map panel, no peek: `j` / `k` open a peek of the step the tour is on.
  - Overview, no peek: `j` / `k` keep today's meaning (close the overview, no move).
  - `n` / `p` / `f` act on the peek's code when a peek is open, and on nothing else while
    the map or overview covers the step pane.
- **What ends a visit.** Any real move to another home ends it: `j`, `k`, `[`, `]`, an outline
  click, following a call or a "→ step N" badge, a jump from the review panel, a "belongs to"
  label. The "Also in this PR" links on the overview open as visits, like the step strip.
- **No nested visits.** There is one way back. Opening another step from the map during a
  visit keeps the original place to return to (the step before the first visit) and updates
  only which map or overview, and which peek, the back button returns to.
- **Folded branches.** When the peek moves to a step inside a folded branch, that branch
  unfolds, so the peeked box is always on screen.

## Narrow windows

Below 800 px wide, the peek covers the map as a full panel with a "← Map" button; Esc returns
to the map.

## Constraints

- Plain English UI copy. No real data from private repos in the repo (use `acme/loans`).
- `npm run check` passes; checked on screen on a separate pr-tour with a copy of real tours.
- No server change.

## Left to the builder

- How the split and the divider are built, within the rules above.
- How the map scrolls the peeked box into view.
- The look of the peek highlight, within the existing colour tokens.
