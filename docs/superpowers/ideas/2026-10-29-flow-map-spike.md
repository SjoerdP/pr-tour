# Flow map: spike results and analysis (2026-10-29)

Input for the flow map design. Not a plan yet.

## Direction from the mockups

- A sequence diagram per flow, built from the tour's links, not drawn freely by Claude.
- Click an arrow to see the code behind it: the call site (call line highlighted) and the
  called function (cut to the exact function, with DB-write, return and sub-step lines
  marked). Move arrow by arrow with the keyboard. A "whole phase" mode stacks a phase's
  functions in call order.
- Claude explains (why, labels, phases). Structure comes from the code where possible.
  Code analysis and Claude are compared, and the map shows where they agree.
- The results must also improve the existing step view, not only the map.

## Spike: Go, PR 1371 (5 flows, 38 steps)

Tools: tree-sitter (web-tree-sitter with tree-sitter-go 0.25 wasm) for function bounds and
call sites; gopls over LSP (definition and implementation, so interface calls resolve to the
real method). gopls ran with `GOPROXY=off`, so no module names leave the machine.

| Finding | Number |
|---|---|
| Steps whose line range equals a function | 2 of 38 |
| Claude's links confirmed by code | 34 of 35 (27 calls, 4 route registrations, 3 through a thin wrapper) |
| Clean links between steps found in code | 25, of which Claude listed 18 |
| Time: gopls load / whole analysis | about 0.8 s / about 2.4 s |

- Claude's line ranges are mostly not functions: whole file chunks (lines 1-146) or a changed
  block that starts at a random small function. Steps need a function anchor.
- A route registration (`router.GET("/x", ctrl.Handler)`) is a link of its own kind: a
  reference, not a call.
- Thin wrappers (`CreateMcpSession` → `createSession`) are hops the tour skips: the `via` case.
- Claude misses links the code shows plainly, for example the `Login`, `Token` and
  `DecideConsent` route registrations and step 8 checking the pinned client (step 7).
- Pitfalls found: the old bundled Go grammar fails on generics (0.25 is fine); never open
  files outside the project in gopls (it broke package loading and made results depend on
  timing). With that fixed, three runs gave identical results.

## Second analysis (Fable), summary

- **Pipeline: code, then Claude, then code.** First list every function the diff touches,
  with exact bounds, and give that table to Claude. Claude names steps by function (file +
  symbol), not by line range. Afterwards, check every link with the language server, find
  links Claude missed, mark DB-write, return and async lines, and give every link a
  provenance. Code wins on position; Claude wins on meaning; a conflict is shown, never
  silently resolved. Without an analyzer for a language, everything is "Claude only" and the
  tour still works.
- **Data model:** a function anchor per step; lanes per flow (actor, controller, service,
  data, bus); phases (contiguous, covering all steps, optionally with their own entry for
  multi-request flows); edges with `how` (call, register, service, event, async) and
  provenance (proven, proven via helper, route match, const match, name match, Claude only,
  discovered, conflict); marks per step (db-write, return, async, event); an `analysis`
  block (engine, version, head SHA, coverage, problems). Keep `from` as the main incoming
  edge so current views keep working.
- **Reliability:** wait for gopls's loading progress before asking, with a hard cap; a run
  with any error is marked degraded, never silently partial; cache per head SHA and engine
  version; skip into generated code; interfaces with several implementations become one
  edge per implementation; closures anchor to their function; a Go fixture module with one
  case per failure mode, with golden files.
- **Step view gains:** focus on the exact function; call links by position instead of by
  name (today a symbol lights up on every line with that word); clickable DB-write lines;
  "called from" with provenance and all callers; conflicts shown; jump to definition for
  calls outside the tour; flag a proven DB write on a step marked "skim".
- **Diagram:** at most 7 lanes; one row per arrow; internal returns hidden; labels cut with
  full text on hover; phases fold; sticky lane header; every arrow focusable with a spoken
  label. Disagrees with the sequence diagram as the only view: it suits multi-actor flows
  (OAuth), but a 13-step flow in one service becomes a column of self-calls, so pick per
  flow: sequence diagram, or an indented call tree. Ship "whole phase" reading early.
- **Beyond competitors:** every arrow has provenance and opens the exact code; the map is a
  review surface (comments, seen marks); rebuilt per head SHA so it never goes stale
  silently; and a base-vs-head edge diff: which calls the PR added or removed in the flow.
- **Plan:** P0 data quality (function anchors, provenance, step view), target 95% of steps
  anchored and 90% of links proven on the real tour. P1 whole-phase reading and call tree.
  P2 sequence diagram with lanes and phases. P3 base-vs-head edge diff and a second language.
