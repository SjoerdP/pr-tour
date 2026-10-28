# pr-tour Plan 1: Tour Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local `pr-tour` web tool that lists the user's PRs, builds a tour for a PR on request (button or `/tour` skill), and lets the user walk the tour in a whole-file code view with "seen" marks.

**Architecture:** One TypeScript package. A Node server (Hono) wraps `gh`, `git` and `claude` CLIs through one injectable command runner, stores tours and seen marks in SQLite, and runs a deterministic check pass that gives every changed line exactly one home. A React + Vite frontend renders the inbox and the tour view; the code view is built on Shiki with pure, tested row/fold functions.

**Tech Stack:** Node ≥ 22, TypeScript (strict, ESM), Hono + @hono/node-server, better-sqlite3, zod v4, parse-diff, React 18, Vite, Shiki, Vitest (+ @testing-library/react, jsdom for web tests).

**Spec:** `docs/superpowers/specs/2026-10-28-pr-tour-design.md`

**Architecture:** `docs/architecture.md` — layers, dependency rules (web imports only shared; shared imports no server/web/Node), where tests live, naming, how to run. Read it before your task. The rules are enforced by `npm run lint` and `npm run typecheck`; `npm run check` runs everything.

This is plan 1 of 3. Plan 2 = review actions (threads, comments, submit review, approve reminder, CI status). Plan 3 = new commits (out-of-date tours, keeping notes and seen marks across rebuilds). Plan 1 stores what plans 2 and 3 need (head SHA per tour, content hash per seen mark) but does not use it.

## Global Constraints

- Runs locally only. No outside services except GitHub through `gh` and Claude through the user's `claude` CLI. No new tokens or accounts.
- Tours are built **only** when the user triggers them (`/tour` or the "build tour" button). No background builds.
- Every changed line in a PR has exactly one home: a foundation item, a flow step, or an "other changes" item. Lines without a home go into an "Unexplained" group.
- "Why" notes are labeled `author` (from `/tour`) or `inferred` (built by the tool).
- Steps are never a gate. "Seen" is set when the user moves past a step.
- Server binds `127.0.0.1` only, default port `4317` (env `PR_TOUR_PORT`). Data dir `~/.pr-tour` (env `PR_TOUR_HOME`).
- Must work for repos in any language: no per-language parsers.
- The `claude` run that builds a tour is read-only: allowed tools `Read`, `Grep`, `Glob` only.

## Review Focus

1. **Binary, renamed, deleted and new files** in the diff: no crash; each still needs a home (binary files via a whole-file home). Tests in Task 2 and Task 3.
2. **Claude returns broken or schema-invalid JSON**: one retry with the validation error, then a clear failure in the UI; nothing partial is stored. Tests in Task 8.
3. **A very large PR**: the diff is written to a file Claude reads, never pasted into the prompt; the code view folds instead of rendering everything open. Tests in Task 8 and Task 4.
4. **Another web page in the user's browser calling the local API** (cross-site request or DNS rebinding): rejected. Tests in Task 9.
5. **The PR got new commits after the tour was built**: the tour still shows correctly against its own head SHA, and the API reports `outdated: true` so the UI shows a banner. Tests in Task 9.

---

## File Structure

```
package.json, index.html, vite.config.ts, vitest.config.ts       (Task 0, done)
tsconfig.json, tsconfig.server.json, tsconfig.web.json, tsconfig.build.json
eslint.config.js, .prettierrc, .editorconfig, .nvmrc, .github/workflows/ci.yml
docs/architecture.md      Layers, dependency rules, testing strategy, naming
src/shared/tour.ts        Tour zod schemas + types (shared by server and web)
src/shared/diff.ts        DiffLine / Hunk / FileDiff types (diff model; also a wire type)
src/shared/rows.ts        buildRows / foldRows / changeBlocks (pure, used by web)
src/shared/api.ts         HTTP wire types: PrSummary, Inbox, TourStatus, Job, PrResponse, ...
src/server/exec.ts        Runner type + real runner (execFile)
src/server/diff.ts        Unified diff -> FileDiff[]; changedLines()
src/server/check.ts       Check pass: homes vs diff -> unexplained + problems
src/server/repo.ts        Bare-clone cache, worktrees, diff text, file at sha
src/server/github.ts      Inbox + PR meta via `gh api graphql`
src/server/store.ts       SQLite: tours, seen marks
src/server/prompt.ts      Tour-building prompt text
src/server/build.ts       Run claude, parse, validate, assign ids, check, store
src/server/jobs.ts        In-memory build jobs (one per PR)
src/server/app.ts         Hono routes + localhost guard
src/cli.ts                `pr-tour`, `pr-tour import`, `pr-tour open`
src/web/main.tsx, App.tsx, api.ts
src/web/Inbox.tsx
src/web/TourView.tsx, Outline.tsx, StepPane.tsx
src/web/CodeView.tsx, highlight.ts, useKeys.ts
skill/tour/SKILL.md       Claude Code skill `/tour`
test/**                   Vitest tests mirroring src/ (test/server, test/shared, test/cli.test.ts: Node)
test/web/**               React tests: run under jsdom automatically; test/web/setup.ts cleans up
test/fixtures/**          Real diffs and canned JSON (read with readFileSync + import.meta.url)
```

Dependency rules (enforced by ESLint): `src/web` imports only `src/shared` and packages; `src/shared` imports no server, web or Node built-ins; `src/server` never imports `src/web`. Every type an `/api` route returns lives in `src/shared` (`api.ts`, `diff.ts`, `tour.ts`). Relative imports end in `.js`.

---

### Task 0: Architecture and tooling (done)

Not part of the original plan; done before Task 1. Created the files listed under "(Task 0, done)" above plus `docs/architecture.md` and two smoke tests (`test/smoke.test.ts`, `test/web/smoke.test.tsx`) that may be deleted once real tests exist in each project. Source directories (`src/shared`, `src/server`, `src/web`, `test/server`, `test/fixtures`, ...) are created by the first task that writes into them; the tool configs already point at them. Scripts: `dev`, `build`, `test`, `test:watch`, `lint`, `format`, `format:check`, `typecheck`, `check`. `package.json` already has `"type": "module"`, `bin`, `engines`, `files: ["dist", "skill"]`.

---

### Task 1: Scaffold and tour schema

**Files:**
- Create: `src/shared/tour.ts`
- Test: `test/shared/tour.test.ts`, `test/fixtures/tour-body.json`

**Interfaces:**
- Produces (in `src/shared/tour.ts`):
  - `Range = { file: string; side: 'new' | 'old'; start: number; end: number } | { file: string; whole: true }` (lines are 1-based, inclusive; `new` = head version, `old` = base version; `whole` = whole file, for binary files)
  - `SideEffect = { kind: 'db-write' | 'event' | 'external-call'; label: string }`
  - `TestRef = { file: string; name: string }`
  - `CallRef = { symbol: string; file: string; line: number }`
  - `Risk = 'read-closely' | 'skim'`
  - `Foundation = { id: string; kind: 'migration' | 'model' | 'config' | 'dependency'; title: string; file: string; why: string; risk: Risk; homes: Range[]; schemaAfter?: string; deployCompat?: { ok: boolean; note: string } }`
  - `Step = { id: string; title: string; symbol?: string; file: string; startLine: number; endLine: number; changed: boolean; why: string; risk: Risk; riskReason?: string; sideEffects: SideEffect[]; tests: TestRef[]; calls: CallRef[]; homes: Range[] }`
  - `Flow = { id: string; title: string; entry: { kind: 'http' | 'job' | 'event' | 'cli' | 'other'; label: string }; steps: Step[] }`
  - `OtherItem = { id: string; file: string; title: string; why?: string; homes: Range[] }`
  - `OtherGroup = { kind: 'refactor' | 'tests' | 'infra' | 'docs' | 'generated' | 'unexplained'; title: string; summary: string; items: OtherItem[] }`
  - `TourBody = { summary: string; foundations: Foundation[]; flows: Flow[]; other: OtherGroup[] }` — what Claude produces. `id` fields are optional in `TourBodyInputSchema` and assigned by Task 8.
  - `TourMeta = { repo: string; pr: number; baseSha: string; headSha: string; source: 'author' | 'inferred'; createdAt: string }`
  - `TourBodyInput` = `z.infer<typeof TourBodyInputSchema>` (same as `TourBody` but ids optional)
  - `Tour = TourBody & TourMeta & { check: { problems: string[] }; hashes: Record<string, string> }` — `hashes` maps every home id to its content hash (set by Task 8); the unexplained group lives in `other`.
  - zod: `TourBodyInputSchema`, `TourBodySchema`, `TourSchema`; `tourBodyJsonSchema(): object` = `z.toJSONSchema(TourBodyInputSchema)`
  - `homeIds(tour: Tour): string[]` — ids of every foundation, step and other item, in tour order.

- [x] **Step 1: Scaffold.** Done by Task 0 (see `docs/architecture.md`): `package.json`, tsconfigs, Vitest projects, ESLint, Prettier, CI. Nothing to do here.

- [ ] **Step 2: Write the failing tests** in `test/shared/tour.test.ts`, using a fixture `test/fixtures/tour-body.json` (read it with `JSON.parse(readFileSync(new URL('../fixtures/tour-body.json', import.meta.url), 'utf8'))`) with 1 migration foundation, 1 flow (`POST /loans/{id}/repay`, 2 steps: one changed `read-closely`, one unchanged), and 1 `tests` other group:
  - `parses a valid body` — `TourBodyInputSchema.parse(fixture)` does not throw.
  - `rejects a step without why` — delete `flows[0].steps[0].why` → `safeParse(...).success === false`.
  - `rejects an unknown risk` — `risk: 'maybe'` → fails.
  - `accepts a whole-file range` — `homes: [{ file: 'logo.png', whole: true }]` parses.
  - `json schema has flows` — `tourBodyJsonSchema()` has `properties.flows`.
  - `homeIds lists all homes in order` — for a tour with ids `f1`, `F1.S1`, `F1.S2`, `o1.1` → returns exactly that array.

- [ ] **Step 3: Run** `npx vitest run test/shared/tour.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/shared/tour.ts`** with the schemas and types above.

- [ ] **Step 5: Run** the same command — Expected: PASS.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: add project scaffold and tour schema"`

---

### Task 2: Diff parsing

**Files:**
- Create: `src/shared/diff.ts` (types only), `src/server/diff.ts`
- Test: `test/server/diff.test.ts`, `test/fixtures/*.diff`

**Interfaces:**
- Produces in `src/shared/diff.ts` (the web renders these, so they live in shared; `src/server/diff.ts` imports and re-exports them):
  - `DiffLine = { kind: 'add' | 'del' | 'ctx'; oldNo?: number; newNo?: number; text: string }`
  - `Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }`
  - `FileDiff = { path: string; oldPath: string; status: 'added' | 'deleted' | 'modified' | 'renamed'; binary: boolean; hunks: Hunk[] }` (`path` = new path; for deleted files `path === oldPath`)
- Produces in `src/server/diff.ts`:
  - `parseDiff(text: string): FileDiff[]`
  - `ChangedLine = { file: string; side: 'new' | 'old'; line: number }` (`file` is `path` for `new`, `oldPath` for `old`)
  - `changedLines(files: FileDiff[]): ChangedLine[]` — adds → `new`, dels → `old`. A binary file yields one entry `{ file: path, side: 'new', line: 0 }`.

- [ ] **Step 1: Write fixtures** with real `git diff --no-color -M` output: `modified.diff` (one hunk, 2 dels, 3 adds), `renamed.diff` (rename with one changed line), `deleted.diff`, `added.diff`, `binary.diff` (`Binary files a/logo.png and b/logo.png differ`).

- [ ] **Step 2: Write the failing tests:**
  - `modified: line numbers` — dels have `oldNo`, adds have `newNo`, ctx has both; `changedLines` returns 2 `old` + 3 `new` entries with the right numbers.
  - `renamed: oldPath and path differ`, `status === 'renamed'`, del lines use `oldPath`.
  - `deleted: status deleted`, all changed lines are `old`.
  - `added: status added`, all changed lines are `new`.
  - `binary: binary true, no hunks`, `changedLines` → `[{ file: 'logo.png', side: 'new', line: 0 }]`.
  - `empty diff returns []`.

- [ ] **Step 3: Run** `npx vitest run test/server/diff.test.ts` — Expected: FAIL.

- [ ] **Step 4: Implement** on top of `parse-diff`, mapping its chunks/changes into the types above. Detect binary from the `Binary files` line when parse-diff gives no chunks.

- [ ] **Step 5: Run** — Expected: PASS.

- [ ] **Step 6: Commit** `feat: parse unified diffs into changed lines`

---

### Task 3: Check pass

**Files:**
- Create: `src/server/check.ts`
- Test: `test/server/check.test.ts`

**Interfaces:**
- Consumes: `TourBody`, `Range`, `homeIds` (Task 1); `FileDiff`, `changedLines` (Task 2).
- Produces:
  - `CheckResult = { problems: string[]; unexplained: OtherGroup | null }`
  - `checkTour(body: TourBody, files: FileDiff[]): CheckResult`

Rules (deterministic, no Claude):
1. For every changed line, count homes whose range contains it (`whole` contains every line of that file, both sides). 0 homes → unexplained. More than 1 → problem `"<file>:<side>:<line> has N homes: <ids>"`.
2. A home range that contains zero changed lines → problem `"<id> home <file>:<start>-<end> covers no changed lines"`.
3. A home on a file not in the diff → problem `"<id> points at <file>, which is not in this PR"`.
4. Unexplained lines are merged into consecutive ranges per file and side; one `OtherItem` per range, ids `u1`, `u2`, …, group `{ kind: 'unexplained', title: 'Unexplained', summary: 'Changed code the tour did not place anywhere.' }`. `null` when none.

- [ ] **Step 1: Write the failing tests** (build bodies inline, diffs from Task 2 fixtures):
  - `all lines homed → no problems, unexplained null`.
  - `missing lines → one unexplained item per consecutive run` — homes cover adds 10–11 but not 12–13 and not del 5 → items `{file,new,12,13}` and `{file,old,5,5}`.
  - `double home → problem naming both ids`.
  - `range with no changed lines → problem`.
  - `home on file outside PR → problem`.
  - `binary file homed by whole range → no unexplained`; `binary not homed → unexplained`.
  - `renamed file: old-side home uses oldPath`.

- [ ] **Step 2: Run** `npx vitest run test/server/check.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `checkTour`.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: add check pass that gives every changed line one home`

---

### Task 4: Code rows, folds and change blocks

**Files:**
- Create: `src/shared/rows.ts`
- Test: `test/shared/rows.test.ts`

**Interfaces:**
- Consumes: `Hunk` from `src/shared/diff.ts` (Task 2).
- Produces:
  - `Row = { kind: 'ctx' | 'add' | 'del'; newNo?: number; oldNo?: number; text: string }`
  - `buildRows(newText: string | null, oldText: string | null, hunks: Hunk[]): Row[]` — the whole file in display order: every line of `newText`, with deleted lines inserted where the hunks put them. `newText === null` (deleted file) → every line of `oldText` as `del`.
  - `Fold = { kind: 'fold'; from: number; to: number; count: number }` (row indexes, inclusive)
  - `Segment = { kind: 'rows'; from: number; to: number } | Fold`
  - `foldRows(rows: Row[], keepOpen: Array<[number, number]>, context = 3): Segment[]` — keep changed rows, `context` rows around them, and the `keepOpen` row ranges (used for the step's `startLine..endLine`) visible; fold the rest. Folds of fewer than 4 rows are shown, not folded.
  - `changeBlocks(rows: Row[]): Array<{ from: number; to: number }>` — consecutive runs of non-ctx rows.

- [ ] **Step 1: Write the failing tests:**
  - `buildRows modified` — 10-line file, hunk replaces line 5 → 11 rows, row 4 is `del` with `oldNo 5`, row 5 is `add` with `newNo 5`, ctx numbers continue correctly after.
  - `buildRows added file` — all `add`.
  - `buildRows deleted file` — all `del`.
  - `foldRows folds far context` — 200-line file, one change at line 100 → segments `[fold 0..95, rows 96..104, fold 105..199]` (with context 3 and the del/add rows).
  - `foldRows keeps step range open` — `keepOpen [[10, 30]]` → rows 10–30 visible.
  - `foldRows does not fold tiny gaps` — two changes 5 rows apart → one `rows` segment.
  - `changeBlocks` — returns one block per run.

- [ ] **Step 2: Run** `npx vitest run test/shared/rows.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: add whole-file rows, folds and change blocks`

---

### Task 5: Command runner and repo manager

**Files:**
- Create: `src/server/exec.ts`, `src/server/repo.ts`
- Test: `test/server/repo.test.ts`

**Interfaces:**
- Produces:
  - `Runner = (cmd: string, args: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>`
  - `realRunner: Runner` (`execFile`, `maxBuffer` 256 MB, never throws on non-zero; returns `code`)
  - `CommandError` (thrown by callers on non-zero, message includes cmd and stderr)
  - `class RepoManager { constructor(home: string, run: Runner, cloneUrl?: (repo: string) => string) }`
    - `ensureWorktree(repo: string, pr: number, baseSha: string, headSha: string): Promise<string>` — returns the worktree path.
    - `diffText(repo: string, baseSha: string, headSha: string): Promise<string>` — `git diff --no-color -M <base>...<head>` (merge-base diff, same as GitHub).
    - `fileAt(repo: string, sha: string, path: string): Promise<string | null>` — `git show <sha>:<path>`; `null` if missing.

Layout: bare clone at `<home>/repos/<owner>__<name>.git`, worktrees at `<home>/worktrees/<owner>__<name>/<headSha>`. Clone with `git clone --bare <cloneUrl(repo)>` (default `cloneUrl` = `https://github.com/<repo>.git`; git uses the `gh` credential helper the user already has). Fetch with `git fetch origin +refs/pull/<pr>/head:refs/pr/<pr> <baseSha>`; skip fetch when both SHAs already exist (`git cat-file -e`). Worktree: `git worktree add --detach <path> <headSha>`, reuse if it exists.

- [ ] **Step 1: Write the failing tests** against a real temporary git repo used as the remote (`cloneUrl` returns its path; create `refs/pull/7/head` in it with `git update-ref`):
  - `ensureWorktree clones, fetches and checks out head` — file content in the worktree equals the head commit's.
  - `ensureWorktree reuses an existing worktree` — second call runs no `git clone` (wrap the runner to record commands).
  - `diffText returns the merge-base diff` — base branch moved after the PR branched: the diff does not include the base branch's later change.
  - `fileAt returns null for a missing path`.

- [ ] **Step 2: Run** `npx vitest run test/server/repo.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: add command runner and repo manager`

---

### Task 6: GitHub client

**Files:**
- Create: `src/server/github.ts`, `src/shared/api.ts`
- Test: `test/server/github.test.ts`

**Interfaces:**
- Consumes: `Runner`, `CommandError` (Task 5).
- Produces (the two types in `src/shared/api.ts`, since the web renders them; `github.ts` imports and re-exports them):
  - `PrSummary = { repo: string; number: number; title: string; author: string; url: string; additions: number; deletions: number; isDraft: boolean; updatedAt: string; baseSha: string; headSha: string }`
  - `Inbox = { reviewRequested: PrSummary[]; mine: PrSummary[] }`
  - `class GitHub { constructor(run: Runner) }`
    - `inbox(): Promise<Inbox>` — one `gh api graphql` call with two aliased `search` queries: `is:pr is:open review-requested:@me` and `is:pr is:open author:@me`, `first: 50`, selecting the `PrSummary` fields (`baseRefOid`, `headRefOid`, `repository.nameWithOwner`, `author.login`).
    - `pr(repo: string, number: number): Promise<PrSummary>` — `gh api graphql` on `repository(owner,name){ pullRequest(number) }`.

- [ ] **Step 1: Write the failing tests** with a fake runner returning canned GraphQL JSON:
  - `inbox maps both lists` — fields mapped, sorted by `updatedAt` desc.
  - `inbox skips non-PR nodes` (empty objects in `nodes`).
  - `pr maps one PR`.
  - `gh failure throws CommandError with stderr` — fake returns `code 1`, stderr `gh: not logged in`.

- [ ] **Step 2: Run** `npx vitest run test/server/github.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: add github client for inbox and pr meta`

---

### Task 7: Store

**Files:**
- Create: `src/server/store.ts`
- Modify: `src/shared/api.ts` (add `TourStatus`)
- Test: `test/server/store.test.ts`

**Interfaces:**
- Consumes: `Tour`, `homeIds` (Task 1).
- Produces:
  - `TourStatus = { exists: boolean; source?: 'author' | 'inferred'; headSha?: string; homes?: number; flows?: number }` in `src/shared/api.ts`.
  - `class Store { constructor(dbPath: string) }` (creates tables if missing; `':memory:'` allowed)
    - `saveTour(tour: Tour): void` — replaces the previous tour for `(repo, pr)`.
    - `getTour(repo: string, pr: number): Tour | null`
    - `tourStatus(repo: string, pr: number): TourStatus`
    - `markSeen(repo: string, pr: number, homeId: string, contentHash: string): void`
    - `seen(repo: string, pr: number): Record<string, string>` — `homeId → contentHash`.
    - `seenCount(repo: string, pr: number): number`
  - Tables: `tours(repo, pr, head_sha, source, json, created_at, PRIMARY KEY(repo, pr))`, `seen(repo, pr, home_id, content_hash, seen_at, PRIMARY KEY(repo, pr, home_id))`.

- [ ] **Step 1: Write the failing tests:**
  - `saveTour then getTour round-trips`.
  - `saveTour replaces the old tour for the same PR`.
  - `tourStatus counts flows and homes`.
  - `markSeen is idempotent and seen returns the hash`.
  - `seen marks survive saveTour` (plan 3 relies on this).

- [ ] **Step 2: Run** `npx vitest run test/server/store.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** with `better-sqlite3`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: add sqlite store for tours and seen marks`

---

### Task 8: Tour builder

**Files:**
- Create: `src/server/prompt.ts`, `src/server/build.ts`
- Test: `test/server/build.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, 5–7.
- Produces:
  - `tourPrompt(args: { diffPath: string; pr: PrSummary; jsonSchema: object; retryError?: string }): string`
  - `assignIds(body: TourBodyInput): TourBody` — foundations `f1…`, flows `F1…`, steps `F1.S1…`, other items `o<group>.<n>` (e.g. `o1.1`). Overwrites any ids Claude gave.
  - `finishTour(body: TourBodyInput, meta: TourMeta, files: FileDiff[]): Tour` — `assignIds`, `checkTour`, append the unexplained group to `other` when not null, set `check.problems`, set `hashes`.
  - `contentHash(lines: string[]): string` — sha1 of the home's changed line texts (in diff order) joined by `\n`. Used now for seen marks; matched across rebuilds in plan 3.
  - `class TourBuilder { constructor(deps: { run: Runner; repos: RepoManager; github: GitHub; store: Store; home: string }) }`
    - `build(repo: string, pr: number, onLog?: (line: string) => void): Promise<Tour>` — source `inferred`.
    - `importAuthorTour(repo: string, pr: number, bodyJson: string): Promise<Tour>` — source `author`; same validation and check pass; no Claude call.

`build` steps: `github.pr` → `repos.ensureWorktree` → `repos.diffText` → write diff to `<home>/tmp/<owner>__<name>-<pr>-<headSha>.diff` → run `claude -p <tourPrompt> --output-format json --allowedTools Read Grep Glob` with `cwd` = worktree, timeout 15 min → take `.result` from the CLI JSON → extract the tour JSON (fenced ```json block if present, else first `{` to last `}`) → `TourBodyInputSchema.safeParse`. On failure, run once more with `retryError` = the zod error / parse error text. On second failure throw `TourBuildError` with the error; nothing is stored. On success `finishTour` and `store.saveTour`.

`tourPrompt` must say: the diff is at `diffPath` (read it with Read); the repo at head is the cwd; output only JSON matching the schema; foundations first (migrations, models, config, dependencies) incl. `schemaAfter` and `deployCompat` for migrations; flows start at an entry point and include unchanged steps on the path; every changed line gets exactly one home (adds → `side: new` head line numbers, dels → `side: old` base line numbers, binary → `whole`); `read-closely` for money math, auth/permissions, DB writes, external calls, concurrency, migrations; fill `sideEffects`, `tests`, and `calls` (definitions of functions the flow calls next); remaining changes go into `other` by kind. Include `jsonSchema` verbatim. Include `retryError` when set.

- [ ] **Step 1: Write the failing tests** (fake runner: answers `gh`, `git`, `claude` from canned outputs; real `Store(':memory:')`; fake `RepoManager`/`GitHub` objects with the same methods):
  - `assignIds numbers everything`.
  - `finishTour adds unexplained group` — body homes miss one line → last `other` group is `unexplained` with one item.
  - `finishTour hashes every home` — `Object.keys(tour.hashes)` equals `homeIds(tour)`; two homes with the same changed lines get the same hash.
  - `build stores an inferred tour` — `getTour` returns it with `source: 'inferred'` and the PR's `headSha`.
  - `build passes the diff as a file, not inline` — the prompt arg contains `diffPath` and does not contain a line from the diff text.
  - `build runs claude read-only` — args include `--allowedTools Read Grep Glob`, cwd is the worktree.
  - `build retries once on invalid JSON` — first claude result `not json`, second valid → stored; the second prompt contains the error text.
  - `build fails after two bad answers and stores nothing` — throws `TourBuildError`; `getTour` → `null`.
  - `importAuthorTour stores an author tour without calling claude`.

- [ ] **Step 2: Run** `npx vitest run test/server/build.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: build tours with claude and check them`

---

### Task 9: HTTP API, build jobs and localhost guard

**Files:**
- Create: `src/server/jobs.ts`, `src/server/app.ts`
- Modify: `src/shared/api.ts` (add `Job`, `InboxPr`, `InboxResponse`, `PrResponse`)
- Test: `test/server/app.test.ts`

**Interfaces:**
- Consumes: Tasks 5–8.
- Produces (wire types in `src/shared/api.ts`; the web client in Task 11 uses them):
  - `Job = { state: 'running' | 'done' | 'failed'; error?: string; log: string[] }`
  - `InboxPr = PrSummary & { tour: TourStatus; seenCount: number }`; `InboxResponse = { reviewRequested: InboxPr[]; mine: InboxPr[] }`
  - `PrResponse = { pr: PrSummary; tour: Tour | null; seen: Record<string, string>; outdated: boolean; job: Job | null }`
  - `class Jobs { start(key: string, fn: (log: (l: string) => void) => Promise<unknown>): void; get(key: string): Job | null }` — starting a key that is `running` is a no-op. The log keeps the last 50 lines.
  - `createApp(deps: { github: GitHub; repos: RepoManager; store: Store; builder: TourBuilder; jobs: Jobs; port: number }): Hono`
  - Routes (`:owner/:name/:pr`):
    - `GET /api/health` → `{ ok: true }`
    - `GET /api/inbox` → `InboxResponse`: the `Inbox` with each PR extended by `tour: tourStatus(...)` and `seenCount`.
    - `GET /api/pr/:owner/:name/:pr` → `PrResponse` — `outdated` = `tour.headSha !== pr.headSha`.
    - `POST /api/pr/:owner/:name/:pr/tour` → starts `builder.build` in `jobs`, returns `202 { job }`.
    - `GET /api/pr/:owner/:name/:pr/file?sha=&path=` → `{ text: string | null }`.
    - `GET /api/pr/:owner/:name/:pr/diff?file=` → `FileDiff` for that file at the tour's base/head SHAs.
    - `POST /api/pr/:owner/:name/:pr/seen` body `{ homeId, contentHash }` → `204`.
    - Everything else under `/` serves the built web app from `dist/web` (SPA fallback to `index.html`). The built server runs as `dist/server/app.js`, so that directory is `new URL('../web/', import.meta.url)`.
  - Guard middleware: reject (`403`) any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`; reject non-GET requests without header `X-PR-Tour: 1`.

- [ ] **Step 1: Write the failing tests** with `app.request(...)` and fake deps:
  - `health ok`.
  - `bad Host is rejected` — `Host: evil.example:4317` → 403.
  - `POST without X-PR-Tour header is rejected` → 403.
  - `inbox includes tour status and seen count`.
  - `pr reports outdated when head moved` — stored tour `headSha a`, PR `headSha b` → `outdated: true`, tour still returned.
  - `POST tour starts one job` — two POSTs → builder called once while running.
  - `failed job shows error` — builder throws `TourBuildError('bad json')` → `GET pr` → `job.state 'failed'`, `job.error` contains `bad json`.
  - `seen stores the mark`.

- [ ] **Step 2: Run** `npx vitest run test/server/app.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: add http api with build jobs and localhost guard`

---

### Task 10: CLI

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 5–9.
- Produces:
  - `pr-tour` → start server on `PR_TOUR_PORT` (default 4317), print the URL, open the browser (`xdg-open` / `open` / `start`). If a server already answers `/api/health`, just open the browser. `PR_TOUR_NO_OPEN=1` skips opening the browser (`npm run dev` sets it, because Vite's URL is the one to use in dev). The file starts with `#!/usr/bin/env node` (tsc keeps it; `bin` points at `dist/cli.js`).
  - `pr-tour import --repo <owner/name> --pr <n> --file <tour-body.json>` → `builder.importAuthorTour`; prints `problems` (if any) and the tour URL `http://127.0.0.1:<port>/pr/<owner>/<name>/<pr>`; exit 1 with the zod error on invalid JSON.
  - `pr-tour open <owner/name>#<n>` → like `pr-tour`, but opens the tour URL.
  - `parseArgs(argv: string[]): { cmd: 'serve' } | { cmd: 'import'; repo: string; pr: number; file: string } | { cmd: 'open'; repo: string; pr: number }` (exported for tests; uses `node:util` `parseArgs`).

- [ ] **Step 1: Write the failing tests:**
  - `no args → serve`.
  - `import parses repo, pr, file`; `import without --file throws a usage error`.
  - `open parses owner/name#12`; `open with a bad ref throws`.

- [ ] **Step 2: Run** `npx vitest run test/cli.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Wire real deps: `realRunner`, `RepoManager(home)`, `GitHub`, `Store(<home>/pr-tour.db)`, `TourBuilder`, `Jobs`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Verify by hand:** `npm run build && node dist/cli.js` → browser opens; `curl -s 127.0.0.1:4317/api/inbox` → JSON with the user's real review requests.

- [ ] **Step 6: Commit** `feat: add pr-tour cli`

---

### Task 11: Web shell and inbox

**Files:**
- Create: `src/web/main.tsx`, `src/web/App.tsx`, `src/web/api.ts`, `src/web/Inbox.tsx`, `src/web/styles.css`
- Modify: `index.html` (add `<script type="module" src="/src/web/main.tsx"></script>` to `<body>`; the `<div id="root">` is already there)
- Test: `test/web/inbox.test.tsx` (runs under jsdom automatically; `test/web/setup.ts` already calls `cleanup` after each test)

**Interfaces:**
- Consumes: API from Task 9; wire types `InboxResponse`, `PrResponse`, `FileDiff` from `src/shared/api.ts` and `src/shared/diff.ts` (never import `src/server` from the web; lint rejects it).
- Produces:
  - `api.ts`: `getInbox(): Promise<InboxResponse>`, `getPr(repo, pr): Promise<PrResponse>`, `buildTour(repo, pr)`, `getFile(repo, pr, sha, path)`, `getDiff(repo, pr, file): Promise<FileDiff>`, `markSeen(repo, pr, homeId, contentHash)` — all non-GET calls send `X-PR-Tour: 1`.
  - Routes (simple `location.pathname` switch, no router library): `/` → `Inbox`, `/pr/:owner/:name/:pr` → `TourView` (Task 12).
  - `vite.config.ts` exists (Task 0): builds to `dist/web`; dev server proxies `/api` to `127.0.0.1:4317`. `npm run dev` runs the server and Vite together.

`Inbox` shows two tables, "Waiting for my review" and "My open PRs". Columns: PR (number + title, links to the tour route), author, size `+a / −d`, tour (`no tour yet` / `N flows · author` / `N flows · inferred`), progress (`seen of homes`). Draft PRs are shown with a "draft" tag.

- [ ] **Step 1: Write the failing tests** (testing-library, mocked `fetch`):
  - `renders both lists`.
  - `shows "no tour yet" when no tour`.
  - `shows "3 flows · author" and "2 of 9 seen"`.

- [ ] **Step 2: Run** `npx vitest run test/web/inbox.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement.** Theme: light and dark via `prefers-color-scheme`. Plain CSS file, no UI library.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: add web shell and inbox`

---

### Task 12: Tour view: outline, step pane, seen marks

**Files:**
- Create: `src/web/TourView.tsx`, `src/web/Outline.tsx`, `src/web/StepPane.tsx`, `src/web/useKeys.ts`
- Test: `test/web/tourview.test.tsx`

**Interfaces:**
- Consumes: `api.ts` (Task 11), `Tour`, `homeIds` (Task 1), `CodeView` (Task 13, props below).
- Produces:
  - `TourView({ repo, pr })` — loads `getPr`. States: no tour → "Build tour" button (calls `buildTour`, then polls `getPr` every 2 s showing the job log until `done`/`failed`; on failure shows the error and a "Try again" button). Tour present → outline + step pane. `outdated` → banner "New commits since this tour was built" with a "Rebuild tour" button.
  - `Outline` — three sections in order: Foundations, Flows (flow title + entry label, then steps), Other changes (groups; `unexplained` group shown first in this section with a warning style when present; `generated` group collapsed by default and marked skim-only; `refactor` groups show their `summary` and expand to items). Each item: title, `changed`/`unchanged`, `read closely` mark, side-effect badges, seen check. Source label at the top: "Notes by the author" / "Notes inferred by Claude". `check.problems` shown in a collapsible list under the outline.
  - `StepPane` — "why" note (labeled author/inferred), risk reason, side effects, tests (warning "no tests cover this step" when `changed` and `tests` is empty), migration `schemaAfter` and `deployCompat` for foundations, then `<CodeView>`.
  - Navigation: `j`/`k` next/prev home in `homeIds` order. Leaving a home (by `j`/`k` or clicking another) marks it seen via `markSeen(repo, pr, homeId, tour.hashes[homeId])`. Seen state updates in the outline without reload.
  - `useKeys(map: Record<string, () => void>)` — ignores keys while typing in inputs.

- [ ] **Step 1: Write the failing tests** (mocked api, stub `CodeView`):
  - `no tour shows Build tour and starts a build`.
  - `failed build shows the error and Try again`.
  - `outline order is foundations, flows, other`.
  - `pressing j marks the current step seen and moves on`.
  - `outdated shows the banner`.
  - `inferred tour labels notes as inferred`.

- [ ] **Step 2: Run** `npx vitest run test/web/tourview.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: add tour view with outline and seen marks`

---

### Task 13: Code view

**Files:**
- Create: `src/web/CodeView.tsx`, `src/web/highlight.ts`
- Test: `test/web/codeview.test.tsx`

**Interfaces:**
- Consumes: `buildRows`, `foldRows`, `changeBlocks` (Task 4); `getFile`, `getDiff` (Task 11); `Tour`, `Range`, `CallRef` (Task 1); `FileDiff` from `src/shared/diff.ts` (Task 2).
- Produces:
  - `CodeView({ repo, pr, tour, file, focus: { start: number; end: number } | null, homeId: string, onJump: (file: string, line: number) => void })`
  - `highlight(text: string, path: string, theme: 'light' | 'dark'): Promise<HighlightedLine[]>` — Shiki, language from file extension, plain text fallback for unknown extensions. Lazy-load Shiki languages.

Behavior:
- Loads the file at `tour.headSha` and `tour.baseSha` plus its `FileDiff`, builds rows, folds with `keepOpen = [focus]`. Scrolls to the focus on mount.
- Folds render as a bar "⋯ N unchanged lines ⋯"; click opens that fold. `f` toggles "whole file" (no folds).
- "Prev change / Next change" buttons and `n`/`p` move between `changeBlocks`, with a counter "change i of N in this file". Moving to a folded block opens its fold.
- Changed rows whose home is another item are labeled "belongs to <item title>" (look up by `Range` across all homes in the tour). Click on the label jumps to that item.
- The step's `calls`: tokens matching `call.symbol` on rows inside the focus range are clickable and call `onJump(call.file, call.line)`. `TourView` handles `onJump` by showing that file with focus on that line (not a home, so no seen mark).
- Binary files: show "Binary file changed" instead of rows.

- [ ] **Step 1: Write the failing tests** (mocked api, stub `highlight` returning plain lines):
  - `folds unchanged code and opens a fold on click`.
  - `n moves to the next change and updates the counter`.
  - `f shows the whole file`.
  - `labels a change that belongs to another item`.
  - `clicking a traced call calls onJump with its file and line`.
  - `binary file shows a placeholder`.

- [ ] **Step 2: Run** `npx vitest run test/web/codeview.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat: add whole-file code view with folds and change jumps`

---

### Task 14: `/tour` skill and end-to-end check

**Files:**
- Create: `skill/tour/SKILL.md`, `README.md`
- Modify: `src/cli.ts`, `test/cli.test.ts` (`package.json` already has `"files": ["dist", "skill"]`, done by Task 0)

**Interfaces:**
- Consumes: `pr-tour import`, `pr-tour open` (Task 10); `tourBodyJsonSchema` (Task 1) — add a `pr-tour schema` command to `src/cli.ts` that prints it, with a test in `test/cli.test.ts`: `schema prints JSON with a flows property`.

`SKILL.md` frontmatter: `name: tour`, `description: Build a pr-tour review tour for the PR you just pushed, using what you know about why each change was made. Use when the user says /tour or asks to open the PR in pr-tour.` Body tells Claude to: find the PR (`gh pr view --json number,url` in the current repo), run `pr-tour schema`, write a tour body following the same rules as `tourPrompt` in `src/server/prompt.ts` (copy those rules into the skill text), using its own memory of why each change was made for the "why" notes; save it to a temp file; run `pr-tour import --repo … --pr … --file …`; if `problems` are printed, fix the homes and import again (max 2 times); then run `pr-tour open <repo>#<pr>`.

README: install (`npm i -g` from the repo), requirements (`gh` logged in, `claude` CLI), install the skill (`cp -r skill/tour ~/.claude/skills/`), usage, and a "Development" section that points at `docs/architecture.md` and `npm run check`.

- [ ] **Step 1: Write the failing test** `schema prints JSON with a flows property`.
- [ ] **Step 2: Run** `npx vitest run test/cli.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `pr-tour schema`, write `SKILL.md` and `README.md`.
- [ ] **Step 4: Run** `npm test` — Expected: all tests PASS.
- [ ] **Step 5: End-to-end by hand** on one real open PR the user owns:
  - `npm run build && npm i -g .` then `pr-tour` → inbox lists the PR.
  - Click it → "Build tour" → job log shows → tour appears with foundations/flows/other; `check.problems` is empty or explains itself; "Unexplained" is empty or each item is real.
  - Walk with `j`/`k`, `n`/`p`, `f`; seen marks persist after reload.
  - In a Claude Code session in that repo, run `/tour` → tour replaced, labeled "Notes by the author".
  Report what worked and what did not.
- [ ] **Step 6: Commit** `feat: add /tour skill and readme`
