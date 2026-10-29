# Code-Checked Tours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor every tour step to its exact function, check every link against the code with a Go checker, let Claude review the findings once, and use the result in the existing step view.

**Architecture:** A separate Go program (`checker/go`, binary `pr-tour-check-go`) does the code analysis with `go/packages`, `go/types` and `go/ast`, and talks JSON over stdin/stdout. The Node server runs it before Claude (pass A: the changed-function table), after Claude (pass B: the check), and once more after a focused Claude review round (pass C). Results are merged into new optional tour fields that the web step view reads; old tours keep working.

**Tech Stack:** Go (toolchain on the user's machine, `golang.org/x/tools/go/packages`), TypeScript/Node 22, zod, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-code-checked-tours-design.md` (read it first; this plan refers to its sections by name).

## Global Constraints

- The checker loads projects with `GOPROXY=off`, `GOFLAGS=-mod=readonly`, `GOTOOLCHAIN=local`. It never downloads anything.
- Hard limit per checker run: 30 seconds. A typed run either finishes completely or is thrown away; then `--syntax-only` runs once; if that fails too, engine is `none`.
- No native Node modules are added.
- A tour build never fails because the checker failed.
- Old stored tours load and display unchanged: every new field is optional in the stored schema.
- Code wins on position (function bounds, which line calls what); Claude wins on meaning. Pass C may not overrule a proven fact.
- Function names are written `Receiver.Method` (pointer stripped, type parameters stripped) or `Function`.
- `npm run build` must succeed without `go`; the checker is then absent.
- Node tests must pass without `go` installed. Go tests run with `go test ./...` in `checker/go`.
- Commit messages: one line, conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), no attribution lines.

## Review Focus

- A step whose `file` does not exist at head (deleted or renamed away): no anchor, a problem line, no crash. Test in Task 3.
- Two functions with the same last name in one file (`A.Run` and `B.Run`, or func `Run` and method `X.Run`): `symbol` matches the exact `Receiver.Method` first; a bare name matches a plain function only. Test in Task 2.
- Files left out of the build (`_test.go`, `//go:build integration`): syntax mode still anchors there; typed mode does not crash and reports the file as not type-checked. Test in Task 4.
- The checker binary missing, not executable, or printing JSON of another `version`: engine `none` with a problem, never a crash. Test in Task 5.
- A non-Go PR (no `.go` file in the diff): the checker is not run; engine `none`; nothing in the UI changes. Test in Task 7.

---

## File Structure

```
checker/go/
  go.mod                      module pr-tour/checker
  main.go                     command dispatch, JSON in/out, exit codes
  contract.go                 the JSON types (mirror of src/server/analysis/contract.ts)
  funcs.go                    syntax: function table, names, bounds (pass A, anchors)
  syntax.go                   syntax-only check: anchors, name-matched links, marks
  typed.go                    typed check: load, resolve, wrappers, discovery, call sites
  *_test.go                   golden tests
  testdata/flow/              fixture module (its own go.mod), one case per hard spot
  testdata/golden/*.json      expected outputs
src/server/analysis/
  contract.ts                 TS types of the JSON contract, CHECKER_VERSION
  runner.ts                   finding and running the binary, limits, fallbacks
  merge.ts                    applying checker output to a Tour, coverage
  findings.ts                 findings list for pass C and for `finding:` lines
  review.ts                   pass C: prompt, change schema, applying changes
src/shared/tour.ts            new optional fields
src/server/build.ts           passes A, B, C in build/import, recheck
src/server/prompt.ts          rules for symbol, side-effect line; function table input
src/cli.ts                    `functions`, `recheck` commands; `finding:` lines
src/web/...                   step view changes (Tasks 8-10)
skill/tour/SKILL.md           `pr-tour functions` step, `finding:` lines
```

---

### Task 1: Checker contract and pass A (`functions`)

**Files:**
- Create: `checker/go/go.mod`, `checker/go/main.go`, `checker/go/contract.go`, `checker/go/funcs.go`, `checker/go/funcs_test.go`
- Create: `checker/go/testdata/flow/go.mod` (module `example.com/flow`) and its packages (see below)
- Create: `checker/go/testdata/golden/functions.json`
- Create: `src/server/analysis/contract.ts`

**Interfaces:**
- Produces (CLI): `pr-tour-check-go functions --root <dir>`; stdin `FunctionsInput`, stdout `FunctionsOutput`. `pr-tour-check-go version` prints `CHECKER_VERSION` (an integer, starting at `1`).
- Produces (TS, `contract.ts`): `CHECKER_VERSION = 1`, and the types below. The Go structs in `contract.go` use the same JSON names.

```ts
export type FunctionsInput = { files: Array<{ path: string; lines: number[] }> }   // head-side changed lines
export type FuncInfo = { file: string; name: string; startLine: number; endLine: number }
export type FunctionsOutput = { version: number; functions: FuncInfo[] }

export type CheckStep = {
  id: string; file: string; symbol?: string; startLine: number; endLine: number
  calls: Array<{ symbol: string; file: string; line: number }>
  from?: { step: number; line: number; how: 'call' | 'service' | 'event' }
  sideEffects: Array<{ kind: 'db-write' | 'event' | 'external-call'; label: string; line?: number }>
}
export type CheckInput = { flows: Array<{ id: string; steps: CheckStep[] }> }
export type Anchor = { name: string; startLine: number; endLine: number; source: 'symbol' | 'incoming-link' | 'range' }
export type Mark = { line: number; kind: 'db-write' | 'event' | 'external-call' | 'async'; label?: string; source: 'code' | 'claude' | 'both' }
export type CallSite = { line: number; col: number; endCol: number; to: { file: string; line: number }; toStep?: string }
export type Link = {
  from: string; to: string; line: number; how: 'call' | 'register' | 'service' | 'event'
  via?: string[]; source: 'claude' | 'code' | 'both'
  check: 'proven' | 'name-match' | 'not-found' | 'conflict' | 'unchecked'; note?: string; reason?: string
}
export type CheckOutput = {
  version: number; engine: 'go-types' | 'go-syntax'; engineVersion: string; degraded: boolean
  steps: Record<string, { anchor?: Anchor; marks: Mark[]; callSites: CallSite[] }>
  links: Record<string, Link[]>          // by flow id
  problems: string[]
}
```

Fixture module `testdata/flow` (packages and functions; keep each tiny):
- `repo/repo.go`: `type Store struct{}`, `func (s *Store) InsertOrder(...) error`, `func (s *Store) DeleteOrder(...) error`.
- `service/service.go`: `type Orders interface { Place(...) error }`; `type OrderService struct{ store *repo.Store }`; `func (s *OrderService) Place(...) error` (calls `s.store.InsertOrder` on a known line and `go s.notify()`); `func (s *OrderService) notify()`; `func (s *OrderService) PlaceWrapped(...) error` (thin wrapper: only `return s.place(...)`); `func (s *OrderService) place(...) error` (calls `s.store.InsertOrder`); `type AuditOrders struct{}` with `Place` (second implementation of `Orders`); a field `name string` on `OrderService` referenced as `s.name`; `func Max[T cmp.Ordered](a, b T) T` (generics); `func Run()` and `func (j *Job) Run()` (same last name).
- `api/api.go`: `type Handler struct{ orders service.Orders }`; `func (h *Handler) Create(...)` (calls `h.orders.Place` through the interface, and `strings.TrimSpace` from the standard library); `func Routes(r *Router, h *Handler)` that registers `r.Handle("/orders", h.Create)` and a closure `r.Handle("/ping", func() { h.ping() })`; `func (h *Handler) ping()`.
- `api/zz_generated.go`: starts with `// Code generated by fixture. DO NOT EDIT.`, `func GeneratedHelper()`.
- `api/integration.go`: `//go:build integration`, `func IntegrationOnly()`.

- [ ] **Step 1: Write the failing golden test** `TestFunctions` in `funcs_test.go`: run `functions` on `testdata/flow` with changed lines covering `Place`, `PlaceWrapped`, `Max`, both `Run`s and `IntegrationOnly`; compare with `testdata/golden/functions.json`. Assert explicitly: `OrderService.Place` (pointer stripped), `Max` (no type parameters), `Run` and `Job.Run` both present, `IntegrationOnly` present (syntax ignores build tags), output sorted by file then startLine.
- [ ] **Step 2: Run** `cd checker/go && go test ./...` — expected FAIL (no `functions`).
- [ ] **Step 3: Implement** `listFunctions(root string, in FunctionsInput) (FunctionsOutput, error)` in `funcs.go` with `go/parser` (with comments, so generated files can be detected later) and `main.go` dispatch (`functions`, `version`; unknown command → exit 2 with usage on stderr). A function is listed when any of its lines (doc comment excluded) is in the input's changed lines. Write `contract.ts` with the types above.
- [ ] **Step 4: Run** `go test ./...` — PASS. Run `go vet ./...` — no output.
- [ ] **Step 5: Commit** `feat: add Go checker with changed-function table`

### Task 2: Syntax-only check (`check --syntax-only`)

**Files:**
- Create: `checker/go/syntax.go`, `checker/go/syntax_test.go`, `checker/go/testdata/golden/check-syntax.json`, `checker/go/testdata/check-input.json`
- Modify: `checker/go/main.go`

**Interfaces:**
- Consumes: Task 1 contract, `funcs.go` function table.
- Produces: `pr-tour-check-go check --root <dir> --syntax-only`; stdin `CheckInput`, stdout `CheckOutput` with `engine: "go-syntax"`.

`testdata/check-input.json` is one flow `F1`: S1 `Routes` (calls `Handler.Create`), S2 `Handler.Create` (`from` S1, calls `OrderService.Place`), S3 `OrderService.Place` (side effect db-write with the `InsertOrder` line; one side effect with a line holding no call; one with a line outside the function), S4 `OrderService.PlaceWrapped` (calls `Store.InsertOrder` — through the wrapper), S5 a step with `symbol` `Nope` and a range starting inside `Max`, S6 `Job.Run`, S7 a step on a file that does not exist.

- [ ] **Step 1: Write the failing golden test** `TestCheckSyntax`. Assertions beyond the golden file:
  - S1..S4, S6 anchored with `source: "symbol"`; S5 anchored to `Max` with `source: "range"` and a problem naming `Nope`; S7 no anchor and a problem naming the missing file.
  - `symbol: "Run"` anchors `Run`, not `Job.Run`; `symbol: "Job.Run"` anchors `Job.Run`.
  - Links from Claude's `calls`/`from` have `check: "name-match"` when a call or reference with that last name exists in the caller's anchored function, else `"not-found"`; `S1→S2` has `how: "register"`.
  - No `source: "code"` links (syntax mode finds no missed links).
  - Marks on S3: the `InsertOrder` line is `db-write`/`both`; the line without a call is `claude`; the line outside the function is dropped and listed in `problems`. The `go s.notify()` line is `async`/`code`.
  - `callSites` are empty in syntax mode.
- [ ] **Step 2: Run** `go test ./...` — FAIL.
- [ ] **Step 3: Implement** `checkSyntax(root string, in CheckInput) (CheckOutput, error)` in `syntax.go`. Anchor order (spec, "Pass B" step 1): `symbol` exact, then (typed mode only) incoming link, then the function around `startLine`, then around `endLine`. A link's `line` is the line of the matched call or reference; `from.line` that differs goes to `note` (spec decision 1). Each step id appears in `steps` even without an anchor.
- [ ] **Step 4: Run** `go test ./...` — PASS.
- [ ] **Step 5: Commit** `feat: add syntax-only tour check to Go checker`

### Task 3: Typed check (`check`)

**Files:**
- Create: `checker/go/typed.go`, `checker/go/typed_test.go`, `checker/go/testdata/golden/check-typed.json`
- Modify: `checker/go/main.go`, `checker/go/go.mod` (add `golang.org/x/tools`)

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: `pr-tour-check-go check --root <dir>`; `engine: "go-types"`.

- [ ] **Step 1: Write the failing golden test** `TestCheckTyped` on the same input. Assertions beyond the golden file:
  - `S2→S3` (`h.orders.Place` through the interface) is `proven`; the second implementation `AuditOrders.Place` gives no link (it is no step).
  - `S1→S2` registration of `h.Create` is `proven`, `how: "register"`; the closure registration resolves to the enclosing function `Routes` (spec decision 5).
  - `S4→` `InsertOrder` is proven with `via: ["OrderService.place"]`.
  - A call into the standard library (`strings.TrimSpace`) produces no link and no `callSite`; the field reference `s.name` produces no link.
  - Discovery: add to the input a step for `OrderService.notify` without any Claude link; the output has a link `S3→notify-step` with `source: "code"`, `check: "proven"`.
  - `callSites` on S2 include `h.orders.Place` with `toStep: "S3"` and exact `line`/`col`/`endCol`.
  - Generated code: a Claude link into `GeneratedHelper` is checked; no `source: "code"` link ends there.
  - Running the check three times gives byte-identical output (sort links by `from`, `line`, `to`; marks and call sites by line, col).
- [ ] **Step 2: Run** `go test ./...` — FAIL.
- [ ] **Step 3: Implement** `checkTyped(root string, in CheckInput) (CheckOutput, error)` in `typed.go`: `packages.Load` with `NeedName|NeedFiles|NeedSyntax|NeedTypes|NeedTypesInfo|NeedDeps|NeedImports`, `Tests: false`, `Env` from the process (the server sets the Global Constraints env). Resolve calls with `TypesInfo.Uses`/`Selections`; for interface methods collect implementations among the loaded project packages' named types (`types.Implements` on `T` and `*T`). A thin wrapper is a function whose body has at most 3 statements and exactly one call to a project function; follow at most one. Packages with errors go to `problems` and links through them use the syntax result (`name-match`). `engineVersion` is the checker's Go module version string plus `runtime.Version()`.
- [ ] **Step 4: Run** `go test ./...` — PASS, and `go vet ./...` clean.
- [ ] **Step 5: Commit** `feat: resolve and discover tour links with go/types`

### Task 4: Typed check on unloadable and partial projects

**Files:**
- Modify: `checker/go/typed.go`, `checker/go/typed_test.go`
- Create: `checker/go/testdata/broken/` (module with one package that has a type error and one that is fine), `checker/go/testdata/missingdep/` (go.mod requiring `example.com/absent v1.0.0`, not in any cache)

- [ ] **Step 1: Write failing tests**
  - `TestTypedPartial` (`broken`): links inside the fine package are `proven`; links through the broken package are `name-match`; `problems` names the broken package; `degraded: true`.
  - `TestTypedMissingDep` (`missingdep`, with `GOPROXY=off`): the command exits non-zero within 30 seconds and prints nothing on stdout (the server then runs `--syntax-only`).
  - `TestTypedBuildTags`: on `testdata/flow`, a step anchored in `api/integration.go` keeps its syntax anchor; `problems` says the file is not type-checked.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the handling: a load where `packages.Load` itself errors → exit 3; per-package errors → partial result as above.
- [ ] **Step 4: Run** `go test ./...` — PASS.
- [ ] **Step 5: Commit** `feat: handle partly loading projects in Go checker`

### Task 5: Node runner

**Files:**
- Create: `src/server/analysis/runner.ts`, `test/server/analysis-runner.test.ts`, `test/fixtures/fake-checker.mjs`

**Interfaces:**
- Consumes: `contract.ts`; `Runner` from `src/server/exec.ts`.
- Produces:

```ts
export type CheckerResult<T> =
  | { ok: true; output: T; ms: number }
  | { ok: false; problem: string; ms: number }
export function checkerPath(): string | null      // PR_TOUR_CHECKER env, else <dist>/bin/pr-tour-check-go if executable
export async function runFunctions(run: Runner, root: string, input: FunctionsInput): Promise<CheckerResult<FunctionsOutput>>
export async function runCheck(run: Runner, root: string, input: CheckInput): Promise<CheckerResult<CheckOutput>>
```

`runCheck` runs typed with a 30 000 ms timeout and the Global Constraints env; on any failure (non-zero exit, timeout, invalid JSON, wrong `version`) it runs `--syntax-only` once; if that fails, `{ ok: false, problem }` naming both failures.

`test/fixtures/fake-checker.mjs` is a node script that reads `FAKE_CHECKER_MODE` (`ok`, `typed-fails`, `both-fail`, `hang`, `bad-json`, `old-version`) and answers accordingly.

- [ ] **Step 1: Write failing tests**, one per mode: `ok` → typed output; `typed-fails` → syntax output (`engine: "go-syntax"`); `both-fail` → `ok: false` with a problem mentioning both; `hang` → typed killed at the timeout (inject a short timeout for the test) and syntax used; `bad-json` and `old-version` → treated as failures; `checkerPath()` returns null when the binary is absent.
- [ ] **Step 2: Run** `npx vitest run test/server/analysis-runner.test.ts` — FAIL.
- [ ] **Step 3: Implement** `runner.ts`; timeout injectable via an options argument defaulting to 30 000.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: run the Go checker from the server with fallbacks`

### Task 6: Tour schema and merge

**Files:**
- Modify: `src/shared/tour.ts`, `test/shared/tour.test.ts`
- Create: `src/server/analysis/merge.ts`, `test/server/analysis-merge.test.ts`

**Interfaces:**
- Consumes: contract types.
- Produces (schema, all optional in `TourSchema`; spec "Data model"): `step.anchor`, `step.marks`, `step.callSites`, `flow.links`, `tour.analysis` (with `review?`); input schema gets `sideEffect.line?`. `Step['symbol']` stays optional in the schema (rules ask for it).
- Produces (`merge.ts`):

```ts
export function checkInput(tour: Tour): CheckInput
export function applyCheck(tour: Tour, result: CheckerResult<CheckOutput> | null, engineMissing?: string): Tour
export function coverage(tour: Tour): NonNullable<Tour['analysis']>['coverage']
```

`applyCheck(tour, null, reason)` sets `analysis.engine: 'none'` with `reason` in `problems`. Coverage per spec decision 2: function steps are steps in `.go` files with an anchor or whose symbol/range points at a function; `links`/`proven` count only `how: 'call' | 'register'`.

- [ ] **Step 1: Write failing tests**: an old tour (no new fields) still parses and `TourSchema.parse` keeps it equal; a stored tour with every new field parses; `applyCheck` copies anchors/marks/callSites to steps by id and links to flows by id, sets `analysis` with `engine`, `ms`, `degraded`, `problems`, `coverage`; unknown step ids in the output are ignored and listed in `problems`; `applyCheck(tour, null, 'no Go files in this PR')` gives engine `none`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite `npx vitest run` — PASS.
- [ ] **Step 5: Commit** `feat: store code-check results on tours`

### Task 7: Passes A and B in build and import; `functions` and `recheck` commands

**Files:**
- Modify: `src/server/build.ts`, `src/server/prompt.ts`, `src/cli.ts`, `test/server/build.test.ts`, `test/server/prompt.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 5-6.
- Produces:
  - `TourBuilderDeps` gains `checker: { functions: typeof runFunctions; check: typeof runCheck }` (tests inject fakes).
  - `TourBuilder.functions(repo, pr): Promise<FunctionsOutput | null>` (checks out head; null when no Go files or no checker).
  - `TourBuilder.recheck(repo, pr): Promise<Tour>` (pass B on the stored tour, saved).
  - `tourPrompt` gains `functionsPath?: string`; `tourRules()` gains the `symbol` and side-effect `line` rules.
  - CLI: `pr-tour functions <owner/name>#<pr>` prints the table as JSON; `pr-tour recheck <owner/name>#<pr>` prints coverage and problems; `importReport` adds `finding: ...` lines (from Task 9's `findings()`; until then, from `analysis.problems`).

- [ ] **Step 1: Write failing tests**
  - build: with Go files in the diff, the prompt mentions the functions file and Claude can read it (`--add-dir` already covers `<home>/tmp`); after Claude, `check` runs on the worktree and the saved tour has `analysis.engine` from the fake; with no `.go` file in the diff, neither checker command runs and engine is `none` with problem `no Go files in this PR`.
  - build: checker failure never fails the build (fake returns `ok: false`) — tour saved, engine `none`.
  - import: pass B runs; `importReport` contains `finding:` lines.
  - recheck: re-runs `check` on the stored tour and saves; content hashes unchanged.
  - prompt: rules contain "name each step that is a function in \"symbol\"" and "give the head \"line\" of the call that does it"; with `functionsPath`, the prompt names that file.
  - cli: `parseArgs(['functions', 'a/b#7'])` and `parseArgs(['recheck', 'a/b#7'])` parse; bad refs give `UsageError`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Pass A input: head-side changed lines of `.go` files from `parseDiff`. Write the table to `<home>/tmp/<slug>-<pr>-<sha>.functions.json` next to the diff file and remove both in the same `finally`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run` — PASS.
- [ ] **Step 5: Commit** `feat: run the code check when building, importing and rechecking tours`

### Task 8: Pass C — Claude reviews the findings

**Files:**
- Create: `src/server/analysis/findings.ts`, `src/server/analysis/review.ts`, `test/server/analysis-review.test.ts`
- Modify: `src/server/build.ts`, `src/cli.ts` (`finding:` lines from `findings()`)

**Interfaces:**
- Produces:

```ts
export type Finding =
  | { kind: 'not-found'; flow: string; link: Link }
  | { kind: 'code-only'; flow: string; link: Link }
  | { kind: 'symbol-missing'; step: string; symbol: string }
  | { kind: 'via'; flow: string; link: Link }
  | { kind: 'mark-no-call'; step: string; line: number }
export function findings(tour: Tour): Finding[]
export function findingText(tour: Tour, f: Finding): string     // one plain line, used for `finding:` output too

export type ReviewChange =
  | { kind: 'symbol'; step: string; symbol: string; reason: string }
  | { kind: 'order'; flow: string; steps: string[]; reason: string }
  | { kind: 'link-how'; flow: string; from: string; to: string; how: 'service' | 'event' | 'register'; reason: string }
  | { kind: 'why'; step: string; why: string; reason: string }
export const ReviewAnswerSchema: z.ZodType<{ changes: ReviewChange[] }>
export function reviewPrompt(tour: Tour, list: Finding[], code: Record<string, string>): string
export function applyReview(tour: Tour, changes: ReviewChange[]): { tour: Tour; applied: ReviewChange[]; dropped: Array<{ change: ReviewChange; why: string }> }
```

Allowed/forbidden per spec "Pass C". `order` must be a permutation of the flow's step ids, else dropped. `link-how` is dropped when that link is `proven`. Changes naming steps or flows that are not in a finding are dropped. `code` holds the source of the anchored functions involved (from the worktree), keyed by step id.

Build: after pass B, if `findings(tour).length > 0`, run one `claude -p` with `reviewPrompt` (same flags as `runClaude`; time limit 180 000 ms), parse with `ReviewAnswerSchema`, `applyReview`, run pass B again, set `analysis.review = { ran: true, ms, changes: applied.map(...) }`. Any failure: keep the pass B tour, `analysis.review = { ran: false, ms, changes: [] }` and a problem line. Not run for imports.

- [ ] **Step 1: Write failing tests**: `findings` lists each kind from a fixture tour; `applyReview` applies a `symbol` change, drops a `link-how` on a proven link, drops an `order` that is not a permutation, drops a change for a step without a finding; build with a fake Claude: second call gets the review prompt, pass B runs twice, `analysis.review.ran` is true and lists applied changes; fake Claude failing on the second call keeps the tour and records the problem; no findings → only one Claude call.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run` — PASS.
- [ ] **Step 5: Commit** `feat: let Claude review code-check findings once`

### Task 9: Step view — anchors and clickable calls by position

**Files:**
- Modify: `src/web/StepPane.tsx` (`codeTarget`), `src/web/CodeView.tsx` (`stepCalls`, `CodeRow`), `src/web/code-lines.ts`, `src/web/TourView.tsx`
- Test: `test/web/codeview.test.tsx`, `test/web/tourview.test.tsx`

**Interfaces:**
- Produces: `export function siteMatches(row: Row, sites: CallSite[]): CallMatch[]` in `code-lines.ts` (by `line`/`col`/`endCol` on the new side); `CallMatch` gains `site?: CallSite`.

- [ ] **Step 1: Write failing tests**
  - focus uses `anchor.startLine..endLine` when present, `startLine..endLine` otherwise.
  - with `callSites`, only the exact columns are clickable: a row containing the same name twice gets one button; without `callSites` the old `callMatches` behaviour stays.
  - a call site with `toStep` in the same flow goes to that step (as `followCall` does today); one without `toStep` opens a quick look at `to.file:to.line` with Back.
  - the button title names the target: "Go to step 3" or "Show OrderService.place".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` — PASS.
- [ ] **Step 5: Commit** `feat: anchor steps to their function and click calls by position`

### Task 10: Step view — called-from with provenance, marks, warnings, About

**Files:**
- Modify: `src/web/homes.ts` (`cameFrom`), `src/web/StepPane.tsx` (`CameFromLine`, `NextFrom`, facts), `src/web/CodeView.tsx` (mark badges), `src/web/TopBar.tsx` (About), `src/web/styles.css`
- Test: `test/web/came-from.test.tsx`, `test/web/codeview.test.tsx`, `test/web/main-screen.test.tsx`

**Interfaces:**
- Produces: `CameFrom` gains `check: Link['check'] | 'unchecked'`, `source: Link['source'] | 'claude'`, `others: Array<{ caller: Step; callerNo: number }>`, `reason?: string`. `cameFrom` prefers `flow.links` (proven first, then Claude's), else today's `from`/`calls` logic.

Copy (exact):
- found by code: `Called from {title} (step {n}), line {line}, found in the code.`
- not found: `The tour says {title} (step {n}) calls this, but the code does not show it.` (warning colour)
- several callers: append `Also called from step {a}, step {b}.`
- conflict strip (only for a `not-found` Claude link plus a code link into the same step, spec decision 1): `The tour says step {x} calls this. The code says step {y} does.`
- About, analysis line: `{anchored} of {functionSteps} steps on their function, {proven} of {links} links proven` and, when engine is `go-syntax`: `The project did not load with types: links are matched by name.`; when pass C ran: a list `{what} — {reason}`.

- [ ] **Step 1: Write failing tests** for each copy line above with fixture tours (extend the worked example in `came-from.test.tsx` with `flow.links`); unchecked links show no warning colour; a `db-write` mark renders a badge on its line, `source: 'claude'` faded; the "writes to DB" fact is a button that reveals the first `both` mark, else the first `claude` mark; About lists analysis and review changes; the next-step note uses `flow.links` (a proven code link from the current step to the next one hides the note, even when Claude's `from` names an earlier step); an old tour shows none of this.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat: show code-check results in the step view`

### Task 11: Build script, skill, docs

**Files:**
- Modify: `package.json` (`build` runs `node scripts/build-checker.mjs` after `tsc`), `skill/tour/SKILL.md`, `README.md`, `docs/architecture.md`
- Create: `scripts/build-checker.mjs`, `test/build-checker.test.ts`

- [ ] **Step 1: Write failing test**: `build-checker.mjs` with `go` absent from PATH exits 0 and prints `go not found: building without the Go checker`; with `go` present it writes an executable `dist/bin/pr-tour-check-go` (skip that case when `go` is missing).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the script (`go build -o ../../dist/bin/pr-tour-check-go .` in `checker/go`). Skill: before step 4 run `pr-tour functions <owner/name>#<number>` and name steps by those functions; in step 5 treat `finding:` lines like `problem:` lines (fix with what you know, re-import, within the existing 2 retries). README: Go is optional, what the check adds. Architecture: the checker and the three passes.
- [ ] **Step 4: Run** `npm run build && npm run check` — PASS; `dist/bin/pr-tour-check-go version` prints `1`.
- [ ] **Step 5: Commit** `chore: build the Go checker and teach /tour the function list`

### Task 12: Acceptance on the real tour (manual)

- [ ] **Step 1:** Restart pr-tour on the new build; rebuild the tour of PR 1371 from the app.
- [ ] **Step 2:** Run `pr-tour recheck <owner/name>#1371` three times; the stored `analysis` (without `ms`) is identical each time.
- [ ] **Step 3:** Check the spec's "Done when": ≥95% function steps anchored, ≥90% of call/register links proven, each check run under 30 s, pass C changes listed in About and none overrules a proven fact. Record the numbers in the PR description.
- [ ] **Step 4:** Move the checker binary away and run `recheck`: the tour stays usable, About says the check did not run.
