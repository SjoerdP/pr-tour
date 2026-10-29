# Code-checked tours: design

Date: 2026-10-29. Status: draft for review.

## Why

A tour is only as good as its links: which function a step is, which step calls it, and on
which line. Today Claude writes all of that, and a spike on a real tour (a real PR of a Go
backend, 5 flows, 38 steps) showed where that goes wrong:

- Claude's line ranges are mostly not functions. Only 2 of 38 steps match a function. Many
  are whole file chunks (lines 1-146) or start at some random small function.
- Claude's links are mostly right. Code confirmed 34 of 35, including route registrations,
  Go interfaces and calls through thin wrappers.
- Claude misses links the code shows plainly: at least 7 of 25 links between steps.
- The web code view finds clickable calls by name, so a function name lights up on every
  line that contains that word.

The goal is the best tour in this field: every step on its exact function, every link
checked against the code, and the reviewer able to see what is proven and what is only
Claude's word. Claude explains (what a step is for, why it changed, how risky it is). The
code decides where things are.

The spike and a second analysis are in
`docs/superpowers/ideas/2026-10-29-flow-map-spike.md`. This design is the first part of
that plan: data quality and the existing step view. The flow map comes later.

## Goals

1. Every step that is a function is anchored to that function's exact lines.
2. Every link between steps is checked against the code and carries its status.
3. Links that Claude missed are found by the code and added, marked as found by code.
4. Lines that write to the DB, emit an event, call an outside service or start a goroutine
   are marked inside the step's code.
5. The existing step view uses all of this (details below).
6. The same result every time for the same commit: no timing-dependent results.
7. Works for Go now; the design keeps other languages possible without a rewrite.

## Non-goals (for now)

- The flow map: sequence diagram, call tree, phases, lanes, responses, whole-phase reading.
  They are a separate view, built later on top of this data.
- Languages other than Go.
- A before/after (base vs head) view of the flow.
- AI review findings.
- More than one round of Claude reviewing the check's findings.

## Anti-goals (a failure even if it works)

- A tour build that fails because the code check failed. The check may degrade; the tour
  is always built.
- Showing a Claude claim as proven.
- Any network request with the user's code or module names (no module downloads).
- Silent partial results: if part of the check did not run, the tour says so.
- A build that gets much slower: each code check stays under 30 seconds, and the pass C
  round is limited in time and only runs when there are findings.

## Constraints

- Everything runs locally, on the worktree pr-tour already checks out at the PR's head
  (`RepoManager.ensureWorktree`), for both builds and author imports.
- The Go checker is a separate Go program in this repo (see "The Go checker"). The Node
  server runs it as a child process and talks to it in JSON. This keeps the best tool for
  Go analysis, and is a first piece of a possible Go backend later.
- Loading the analysed project runs with `GOPROXY=off`, `GOFLAGS=-mod=readonly` and
  `GOTOOLCHAIN=local`. It only uses the user's module cache. Missing modules make the
  check degrade, never download.
- The `go` command comes from the user's machine; loading a Go project needs it anyway.
  pr-tour does not install it. Without `go`, there is no Go check (engine `none`).
- No native Node modules are added: pr-tour may become a Claude Code plugin, which cannot
  build them.
- Old stored tours must keep loading and showing as they do today.

## How a tour is built

Three passes: code, then Claude, then code.

### Pass A: list the changed functions (before Claude, about 1 second)

For every Go file in the diff, the checker lists each function and method that contains a
changed line (head side): file, name (`Receiver.Method` or `Function`), exact start and end
line. This needs only the syntax (`go/parser`), so it is fast and always works. The table
goes into Claude's prompt as a file, next to the diff.

### Claude (as today, with new rules)

- Name each step that is a function in `symbol`, exactly as written in the table, or as
  `Receiver.Method` / `Function` for unchanged functions not in the table.
- `startLine` and `endLine` stay (old tours and other languages need them), but are a hint
  when `symbol` is set.
- For each side effect, give the head `line` of the call that does it (new optional field).
- Everything else is unchanged: which functions matter, order, why, risk, `from`, `calls`.

Schema errors still send the answer back to Claude, as today. Findings of the code check
go to Claude once, in pass C.

### Pass B: check against the code (after Claude, hard limit 30 seconds)

1. **Anchor every step.** Find the function named by `symbol` in `file`. If it does not
   exist or `symbol` is empty, use the function that a proven incoming link lands on. Else
   the function around `startLine`. A step that is not a function (a template, a config
   file) keeps its Claude range.
2. **Check every link Claude gave**: each `from` and each `calls` entry. Find the call (or
   reference, for route registrations like `router.GET("/x", ctrl.Handler)`) in the calling
   step's function, then resolve where it goes with `go/types`. A call on an interface
   resolves to every concrete type in the project that implements it. Follow at most one
   thin wrapper in between and record it in `via`.
3. **Find missed links.** Resolve every call and reference in every anchored step's
   function. Keep those that land in another step's function of the same flow. Ignore
   struct fields and anything outside the project (standard library, dependencies).
4. **Mark lines**: DB writes, events and outside calls (from the side effects' lines,
   checked to hold a call), and `go` statements (found by code).
5. **Record call sites by position**: for every call in a step's function that goes to
   another step or to a known function, store line, column and target.

Rules: the code wins on position (where a function is, which line calls what). Claude wins
on meaning (labels, why, risk). A disagreement is stored and shown. It is never fixed
silently.

### Pass C: Claude reviews the findings (only when there are findings)

A disagreement often means the story is a bit off, and only Claude can fix the story. So
when pass B has findings, Claude gets one focused round to review them.

- **Findings** are: links Claude gave that the code did not find (`not-found`), links found
  only by code (`source: 'code'`), steps whose `symbol` was not found, links through a thin
  wrapper (`via`), and side-effect lines that hold no call.
- **Input:** only the findings, the steps involved (title, why, symbol, anchor) and the
  code of the functions involved. Not the whole diff again.
- **What Claude may change:** a step's `symbol` (it meant another function), the order of
  steps within a flow, a link's `how` with a short `reason` (for example "registered through
  dependency injection", "HTTP call to the ledger service"), and why notes. It answers with
  a list of changes in a fixed JSON shape, each with a one-line reason.
- **What Claude may not change:** anything the code proved (where a function is, what a
  line calls), homes, or anything not in a finding. Changes that touch these are dropped.
- **After pass C, pass B runs once more** on the changed tour. Its result is final; there
  is no second round.
- **Limits:** one round, with a time limit (builder's call, around 3 minutes). If Claude
  fails, times out or answers with an invalid shape, the tour from pass B is kept and
  `analysis.problems` says so.
- **Shown to the reviewer:** About this PR lists what pass C changed and why, e.g. "Step 20
  now points at createSession, not CreateUserSession: the DB writes are there." A link
  Claude explained but code cannot prove stays unchecked, with Claude's reason in its
  tooltip.
- **Author tours** (`/tour`): `pr-tour import` prints the findings as `finding: ...` lines,
  the same way it prints problems today. The skill fixes them with what it knows and
  imports again, within its current limit of 2 retries. The authoring session is the
  reviewer; pr-tour runs no extra Claude call for imports. *(my call)*

### When the check cannot run fully

| Situation | Engine | Result |
|---|---|---|
| `go` present, project loads with types | `go-types` | Full check |
| Project does not load with types (missing modules, build errors), or the time limit hits | `go-syntax` | Syntax only: anchors, and Claude's links "matched by name" |
| No `go`, or not a Go project | `none` | Nothing checked: as today |

Each run records which engine ran and every problem. Packages that fail to type-check are
listed in `analysis.problems`; links that pass through them fall back to "matched by name",
never to proven. *(Builder's call whether partly loaded packages are used, as long as the
same input always gives the same output.)*

## The Go checker

A small Go program, `pr-tour-check-go`, kept in this repo (for example under `checker/go/`
with its own `go.mod`).

- **Libraries:** `golang.org/x/tools/go/packages` to load the project the way `go build`
  does, `go/types` to resolve calls, `go/ast` for function bounds and call sites. It loads
  synchronously, so there is no background server to wait for (the spike's gopls timing
  problem does not exist here).
- **Interface:** JSON in on stdin, JSON out on stdout, one run per call.
  - `pr-tour-check-go functions --root <worktree>`: input is the changed lines per file;
    output is the Pass A table.
  - `pr-tour-check-go check --root <worktree> [--syntax-only]`: input is the tour body with
    ids; output is everything pass B adds (anchors, marks, call sites, links, analysis).
  - Errors go to stderr; a non-zero exit means "no result", and the server falls back.
- **The server side** (Node): runs the checker with the environment above and a hard time
  limit of 30 seconds. If the typed run fails or times out, it runs `--syntax-only` once.
  If that fails too, the engine is `none`. It then merges the output into the tour.
- **Building it:** `npm run build` also runs `go build` for the checker into `dist/bin/`.
  If `go` is missing at build time, the build still succeeds and the checker is simply
  absent. *(Builder's call whether to vendor the checker's own dependencies; downloading
  the public `golang.org/x/tools` module once is fine.)*
- **Other languages later** get their own checker behind the same JSON interface, for
  example one that talks to the language's server (jdtls, typescript-language-server).
- **Go version:** the checker must parse the newest Go syntax the analysed projects use;
  keep `golang.org/x/tools` current.

## Data model

New fields. All optional in the stored schema, so old tours load unchanged.

```ts
// Claude's input (TourBodyInputSchema)
step.symbol?: string                // now asked for every function step
sideEffect.line?: number            // the line of the call that does it

// Filled by pass B (stored tour only)
step.anchor?: {
  name: string                      // e.g. 'OrderService.Place'
  startLine: number
  endLine: number
  source: 'symbol' | 'incoming-link' | 'range'   // how it was found
}
step.marks?: Array<{
  line: number
  kind: 'db-write' | 'event' | 'external-call' | 'async'
  label?: string
  source: 'code' | 'claude' | 'both'
}>
step.callSites?: Array<{
  line: number; col: number; endCol: number
  to: { file: string; line: number }   // the called function's first line
  toStep?: string                      // when it is another step of the tour
}>
flow.links?: Array<{
  from: string; to: string             // step ids
  line: number                         // the call or registration line in `from`
  how: 'call' | 'register' | 'service' | 'event'
  via?: string[]                       // thin wrappers in between
  source: 'claude' | 'code' | 'both'   // who named this link
  check: 'proven' | 'name-match' | 'not-found' | 'conflict' | 'unchecked'
  note?: string                        // e.g. what the code says instead, for a conflict
  reason?: string                      // Claude's explanation from pass C, for a link code cannot prove
}>
tour.analysis?: {
  engine: 'go-types' | 'go-syntax' | 'none'
  engineVersion?: string
  ms: number
  degraded: boolean
  coverage: { functionSteps: number; anchored: number; links: number; proven: number; foundByCode: number }
  problems: string[]
  review?: {                           // pass C
    ran: boolean
    ms: number
    changes: Array<{ step?: string; what: string; reason: string }>
  }
}
```

`from` stays as it is. The step view takes the "called from" line from `flow.links` when
present (proven first, then Claude's), and from `from` for old tours.

Service and event hops (`how: 'service' | 'event'`) cannot be proven from types alone. They
are stored with `check: 'unchecked'` in this version.

## The step view

1. **The frame sits on the anchored function.** `codeTarget` uses `anchor` when present.
2. **Clickable calls by position.** The code view uses `callSites` (line and column) when
   present. The name-based `callMatches` stays only for old tours. A call into a step
   shows that step's number in its tooltip.
3. **"Called from" shows the check.**
   - Proven: as today, e.g. "Called from Handle the repay request (step 1), line 14."
   - Found by code (Claude did not list it): same line, plus "found in the code".
   - Claude only (not found in the code): the line says so in the warning colour.
   - Several callers: the main one first, then "Also called from step 5, step 9."
4. **Marked lines.** DB-write, event, outside-call and goroutine lines get a small badge in
   the code. The "writes to DB" fact becomes a button that shows the first such line.
5. **Conflicts.** A warning strip in the step notes, e.g. "The tour says step 7 calls this.
   The code says step 5 does."
6. **About this PR** shows the check: engine, "35 of 38 steps on their function, 31 of 34
   links proven", and any problems, including "the project did not load with types: links
   are matched by name".
7. **Next step note** (shipped earlier) uses `flow.links` when present.

## Decisions on edge cases (my calls, after the builder check)

1. **Disagreements.**
   - Claude names the right caller but the call line is off: the link is proven and stores
     the code's line. Claude's line goes in `note`. No warning.
   - Claude says step 7 calls this step, the code says step 5 does: two links. Claude's gets
     `check: 'not-found'`. The code's gets `source: 'code'`, `check: 'proven'`. The step view
     shows the "tour says 7, code says 5" warning only in this case: a not-found Claude link
     plus a code link into the same step.
   - `symbol` names function X but the proven call lands on function Y: the anchor stays X
     (Claude chose the step), the link gets `not-found`, and the case is added to
     `analysis.problems`.
   - `conflict` is not used in this version. It is kept in the type for later.
2. **"Done when" measures.**
   - Same result every time means: pass B run three times on one stored tour gives
     identical output. This needs a `pr-tour recheck <owner/name>#<pr>` command that re-runs
     pass B on the stored tour. It is also useful after fixing a project that did not
     load, or after a checker update.
   - A function step is a step in a `.go` file whose `symbol` or range points at a function
     or method. Steps on types, variables, constants or non-Go files do not count.
   - The 90% counts links with `how: 'call' | 'register'` only, from both Claude and code.
     Service and event hops are left out.
3. **Time limit.** The typed run either finishes completely or is thrown away. If it
   hits the limit, the result is the syntax-only result, marked degraded. Results never
   depend on how far a run got.
4. **Syntax-only mode** checks Claude's links by name (`check: 'name-match'`) and anchors
   steps. It does not find missed links by name, because that would bring back the noise
   this design removes.
5. **Fixture cases.**
   - Generated code: a step may be anchored there, and Claude's links into it are checked.
     Pass B does not add code-found links into generated code, and does not follow wrappers
     through it.
   - A closure handler (`router.GET("/x", func(c){...})`): the anchor is the enclosing
     named function. A registration that lands on the closure counts as proven to that step.
   - An interface with two implementations: Claude's link is proven when one of them is
     Claude's target. If the other one is also a step, it gets its own code-found link.
6. **Unchecked links** (service and event hops, non-Go tours, old tours) show as they do
   today, without a warning colour. The warning colour is only for `not-found`: checked,
   and not there.
7. **Side-effect lines.** A line holding a call becomes a mark with `source: 'both'`. A line
   holding no call stays a mark with `source: 'claude'`, shown faded. A line outside the
   step's function is dropped and listed in `analysis.problems`. The "writes to DB" button
   goes to the first `both` mark, else the first `claude` mark.
8. **Clickable calls.** Every call in a step's function that resolves to a function in the
   project gets a `callSite`. A call into a step jumps to that step, as today. Any other
   project function opens as a quick look at its definition, with Back. That gives the
   tour jump-to-definition. Calls into the standard library and dependencies are not
   clickable.

## The /tour skill

Both ways of making a tour get the same three passes. Only who plays Claude differs: for
"Build tour" it is a `claude` run started by pr-tour; for `/tour` it is the author's own
session, which wrote the code.

- **Pass A:** a new command, `pr-tour functions <owner/name>#<pr>`, checks out the PR's
  head (as the import does) and prints the Pass A table. The skill runs it before writing
  the tour, so both ways start from the same exact list of functions.
- **Rules:** the skill's rules come from `pr-tour rules`, so they pick up the new `symbol`
  and side-effect `line` rules on their own.
- **Pass B:** the import runs it (the worktree is already checked out there).
- **Pass C:** see "Pass C" above: the import prints the findings and the skill fixes them.

The skill text (`skill/tour/SKILL.md`) gets a step for `pr-tour functions` and a line on
`finding:` output, next to the existing one on `problem:` lines.

## Testing

- **A fixture Go module** at `test/fixtures/go-flow/` with one case per hard spot: a direct
  call, an interface with one and with two implementations, a thin wrapper, a route
  registration, a closure handler, generics, generated code (`// Code generated`), a
  goroutine, a struct field that must not count as a link, and a call into the standard
  library.
- **Golden files** for pass A and pass B on that module, tested with `go test` inside the
  checker. Typed and syntax-only output each get their own golden file.
- **Node tests** cover running the checker, the fallbacks (failure, time limit, missing
  binary) and the merge into the tour, with a fake checker that returns fixed JSON. They
  must pass without `go` installed.
- **Pass C tests** use a fake Claude runner (as the build tests do today): allowed changes
  are applied, forbidden ones dropped, a failure keeps the pass B tour, and pass B runs once
  more afterwards.
- **The real tour** (a real PR) is the acceptance check, run by hand, not in CI.
- **Web tests** for every step-view change, with fixture tours, the same way as
  `test/web/came-from.test.tsx`.

## Done when

On a fresh build of the acceptance PR:

- at least 95% of function steps are anchored to their exact function,
- at least 90% of links between steps are proven,
- three builds in a row give identical analysis results,
- each code check takes under 30 seconds,
- pass C runs, its changes are listed in About this PR, and none of them overrules a
  proven fact,

and when the typed run cannot load the project, the tour still builds, shows "matched by
name", and says so in About this PR.

## Left to the builder

- Layout of the checker and of the Node side (for example `src/server/analysis/` with a
  language-neutral runner), and the exact JSON shapes between them.
- How the Pass A table is formatted in the prompt.
- Styling of badges, warnings and the About section, within the current design tokens.
- Small heuristics (what counts as a thin wrapper), as long as the fixture cases pass.

## Later (not in this design)

The flow map as a separate view (sequence diagram or call tree per flow, phases, lanes,
responses, whole-phase reading); the before/after flow view; more languages through their
language servers; caching analysis separately from the tour; possibly moving the whole
backend to Go, starting from this checker.
