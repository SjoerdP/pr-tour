# Possible problems from GitHub: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show possible problems from GitHub (CI annotations, failed checks, bot review threads) on the overview, under their line in the code, at the top of a step, as pins, and in the approve reminder, with "Real problem" / "Not a problem" marks.

**Architecture:** A shared model (`src/shared/problems.ts`) defines a problem, its level, where it is, how it is placed in the tour, merged and sorted. The server reads check runs and their annotations for the tour's head commit through `gh` and turns them into problems (filtered to changed lines); the web app adds problems from bot threads it already loads with the review. Marks live in a new SQLite table. The web app shares problems and marks through one React context that the overview, code view, step pane, outline, map and review panel read.

**Tech Stack:** TypeScript, zod, Hono, better-sqlite3, React, vitest + Testing Library, `gh api graphql`.

**Spec:** `docs/superpowers/specs/2026-11-07-possible-problems-design.md` (this plan is its PR 1: "Possible problems from GitHub").

## Global Constraints

- Plain English UI copy; short sentences. Level names exactly: `Likely bug`, `Risk`, `Worth a look`. Colours: red, orange, blue, from the existing colour tokens (add tokens if missing, with dark-mode values).
- No real data from private repos in this repo: tests use `acme/loans`.
- Only GitHub is called, through `gh` (the existing `Runner`). Nothing new about the user is sent anywhere.
- CI problems are read for the tour's `headSha`, never the PR's latest commit.
- CI annotations are shown only on lines the PR changed (added lines on the new side).
- A failed check run with line annotations shows only through those annotations; one without is one problem.
- Resolved and outdated bot threads are not problems. Bot comments outside threads are not read.
- Marks are local. A line problem's identity is built from source, file, line text and title; a step/file/PR-wide problem's identity also includes the head commit. Bot threads use the thread id (GitHub makes a thread outdated when its line changes, which ends it as a problem; this is the plan's reading of the spec's "mark is gone when the line changes").
- Never blocks: a failure to read CI is a muted note; approving anyway stays possible.
- `npm run check` passes before each commit; UI checked on screen in a separate pr-tour (`PR_TOUR_HOME=<scratch dir> PR_TOUR_PORT=4399 PR_TOUR_NO_OPEN=1 node dist/cli.js`), never `~/.pr-tour`.

## Review Focus

1. A tour that is outdated (PR head moved): CI is read for the tour's head, and a muted note says newer CI results are not shown. Test in Task 3.
2. GitHub Actions' own annotations ("Process completed with exit code 1", path `.github`) must not show: they are on no changed line. Test in Task 2.
3. A bot thread and a CI annotation within 2 lines of each other on the same file show once (as the thread, with both sources and the higher level). Test in Task 1.
4. A problem on a changed line that no home holds (a whole-file home, or an unexplained line): listed under "Elsewhere in this PR", never dropped. Test in Task 1 (placement) and Task 4 (list).
5. Clicking a pin opens neither the step nor the peek. Test in Task 6.

---

### Task 1: The shared problem model

**Files:**
- Create: `src/shared/problems.ts`
- Test: `test/shared/problems.test.ts`

**Interfaces:**
- Produces:
  - `type Level = 'bug' | 'risk' | 'look'`; `LEVEL_LABEL: Record<Level, string>` = `{ bug: 'Likely bug', risk: 'Risk', look: 'Worth a look' }`; `LEVEL_ORDER: Level[]` = `['bug','risk','look']`.
  - `type ProblemAt = { kind: 'line'; file: string; side: 'new' | 'old'; line: number } | { kind: 'step'; test: string } | { kind: 'file'; file: string } | { kind: 'pr' }`.
  - `type Problem = { key: string; level: Level; title: string; why?: string; sources: string[]; at: ProblemAt; url?: string; threadId?: string }`.
  - `type PlacedProblem = Problem & { homeId: string | null }`.
  - `placeProblems(tour: Tour, problems: Problem[]): PlacedProblem[]`: a line problem goes to the step whose `file` matches and whose `startLine..endLine` holds the line (new side), else the home whose `homes` ranges hold it (steps, then foundations, then other items); a `step` problem goes to the first step whose `tests` has that name; a `file` problem to the first home whose ranges name the file; else `homeId: null`.
  - `mergeProblems(problems: Problem[]): Problem[]`: two line problems merge when same file and side, lines at most 2 apart, and at least one has a `threadId` (a bot). The merged one keeps the thread's `key`, `threadId`, `title`, `why`, `url` and `at`; takes the higher level; `sources` is the union, thread's first. Two problems without a thread never merge.
  - `sortProblems(tour: Tour, placed: PlacedProblem[]): PlacedProblem[]`: by level (`LEVEL_ORDER`), then PR-wide first, then home order (`homeIds(tour)`), with `homeId: null` last, then line.
  - `botLevel(body: string): Level`: `'risk'` when the body contains `Potential issue` (CodeRabbit's label); else `'look'`. The mapping is a small table in the file so more bots can be added.
  - `botTitle(body: string): string`: the first line that is not only a label (`_⚠️ Potential issue_`, `_🛠️ Refactor suggestion_`, or a line made only of emoji, `*` and `_`), with `*`, `_` and backticks around words removed, cut to 100 characters with `…`.
  - `isBotLogin(login: string): boolean`: ends with `[bot]` (used together with the GraphQL `Bot` type in Task 2).

- [ ] **Step 1: Write the failing tests**

On the `acme/loans` fixture tour (`test/web/tour-fixture.ts` exports `tour`; build a small one inline if it lacks a step with `tests`):
- `it('places a line problem on the step whose range holds it')`, `it('places it on a foundation or other item by its homes')`, `it('leaves a line no home holds with homeId null')`.
- `it('places a failing test on the step that lists it')`, `it('places a file problem on the first home of that file')`, `it('keeps a PR-wide problem unplaced')`.
- `it('merges a CI annotation into a bot thread 2 lines away')`: level `bug` wins over `look`; sources `['CodeRabbit', 'golangci-lint']`; key is the thread's.
- `it('does not merge two annotations on the same line')`, `it('does not merge 3 lines apart')`.
- `it('sorts by level, then PR-wide, then tour order, unplaced last')`.
- `it('botLevel reads CodeRabbit potential issues as a risk')`, `it('botTitle skips the label line and strips markdown')` with body `'_⚠️ Potential issue_\n\n**Charge the fee before saving.**\n\nMore text'` → `'Charge the fee before saving.'`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/shared/problems.test.ts`

- [ ] **Step 3: Implement `src/shared/problems.ts`**

- [ ] **Step 4: Run the tests**

- [ ] **Step 5: Commit**

`git commit -m "feat: add the possible problems model"`

---

### Task 2: Reading CI problems from GitHub

**Files:**
- Create: `src/server/problems-github.ts`
- Modify: `src/server/review-github.ts` (comment author `__typename`; `ReviewThread.bot`)
- Modify: `src/shared/review.ts` (`ReviewThread.bot: boolean`)
- Test: `test/server/problems-github.test.ts` (new), `test/server/review-github.test.ts`

**Interfaces:**
- Consumes: `Problem`, `Level` (Task 1); `ghGraphql` (`src/server/graphql.ts`); `FileDiff`, `lineChanges` (`src/server/diff.ts`).
- Produces:
  - `ReviewThread.bot`: true when the first comment's author is GraphQL type `Bot` or `isBotLogin(login)`. Query change: `author { login __typename }`.
  - `type CheckRunNode = { name: string; status: string; conclusion: string | null; detailsUrl: string | null; summary: string | null; text: string | null; annotations: { nodes: Array<{ path: string; annotationLevel: 'NOTICE' | 'WARNING' | 'FAILURE'; title: string | null; message: string; location: { start: { line: number }; end: { line: number } } }> } }`.
  - `class ProblemsGitHub { constructor(run: Runner); checkRuns(repo: string, sha: string): Promise<{ runs: CheckRunNode[]; pending: boolean }> }`: one `gh api graphql` query on `repository(owner, name) { object(oid: $sha) { ... on Commit { statusCheckRollup { state } checkSuites(first: 50) { nodes { checkRuns(first: 100) { nodes { …CheckRunNode fields, annotations(first: 100) } } } } } } }`. `pending` is true when the rollup state is `PENDING` or `EXPECTED`.
  - `ciProblems(runs: CheckRunNode[], files: FileDiff[], tour: TourBody): Problem[]` (pure):
    - each annotation on an added line of the diff (new side, a `+` line of a file in `files`) → a line problem: level `FAILURE→bug`, `WARNING→risk`, `NOTICE→look`; `title` = annotation `title` or the message's first line; `why` = the rest of the message when the title came from `title`; `sources: [run.name]`; `url: run.detailsUrl`; `key: 'ci|' + run.name + '|' + path + '|' + lineText + '|' + title`. Other annotations are dropped.
    - each run with a failed conclusion (`FAILURE`, `TIMED_OUT`, `STARTUP_FAILURE`; the set `review-github.ts` already uses) and no kept annotation → one problem: level `bug`, title `CI check "<name>" fails`. When a step `tests` name appears as a whole word in the run's `summary` or `text`, `at: { kind: 'step', test }` (one problem per matched test, title `Test <name> fails in CI`); else `at: { kind: 'pr' }`. `sources: ['CI']`; `key: 'ci|' + headSha + '|' + name + '|' + (test ?? '')`.

- [ ] **Step 1: Write the failing tests**

`ciProblems`, with a diff fixture of `loans/fees.go` adding lines 39-42:
- `it('turns an annotation on an added line into a line problem with its level')` (`WARNING` → `risk`, key contains the line text).
- `it('drops annotations on unchanged lines and outside the PR')` (line 12 of the file; path `.github`, message `Process completed with exit code 1.`).
- `it('a failed run with kept annotations adds no card of its own')`.
- `it('a failed run without annotations is one PR-wide problem')`.
- `it('places a failed run on a step when a step test name is in its summary')` (step tests `[{ file: 'loans/fees_test.go', name: 'TestChargeFee' }]`, summary `--- FAIL: TestChargeFee (0.01s)`).
- `it('a successful run adds nothing')`.

`ProblemsGitHub.checkRuns`: `it('asks for the given commit and reads pending')` with a fake `Runner` returning JSON; assert the `oid` variable is the sha.

`review-github`: `it('marks threads started by a bot')` (author `{ login: 'coderabbitai', __typename: 'Bot' }`) and `it('marks [bot] logins as bots')`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/server/problems-github.test.ts test/server/review-github.test.ts`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and `npm run check`** (fixtures that build `ReviewThread` need `bot: false`).

- [ ] **Step 5: Commit**

`git commit -m "feat: read possible problems from CI on GitHub"`

---

### Task 3: Marks and the problems route

**Files:**
- Modify: `src/server/store.ts` (new migration, methods)
- Modify: `src/server/review-routes.ts` (two routes), `src/server/app.ts` and `src/cli.ts` (wire `ProblemsGitHub`)
- Modify: `src/shared/api.ts` (types), `src/web/api.ts` (calls)
- Test: `test/server/store.test.ts`, `test/server/review-routes.test.ts`

**Interfaces:**
- Consumes: `ProblemsGitHub`, `ciProblems` (Task 2); `Problem` (Task 1).
- Produces:
  - Table `problem_marks (repo TEXT, pr INTEGER, key TEXT, mark TEXT /* 'real' | 'not' */, marked_at TEXT, PRIMARY KEY (repo, pr, key))`, appended to `MIGRATIONS`.
  - `Store.setProblemMark(repo: string, pr: number, key: string, mark: 'real' | 'not' | null): void` (null deletes); `Store.problemMarks(repo: string, pr: number): Record<string, 'real' | 'not'>`.
  - `type ProblemsResponse = { problems: Problem[]; marks: Record<string, 'real' | 'not'>; pending: boolean; outdated: boolean; error: string | null }` in `src/shared/api.ts`.
  - `GET /api/pr/:owner/:name/:pr/problems`: needs a stored tour (404 like other tour routes). Reads `checkRuns(repo, tour.headSha)`, the diff (`repos.diffText(repo, tour.baseSha, tour.headSha)`), returns `ciProblems(...)`. `outdated`: the PR's head differs from `tour.headSha`. A GitHub failure gives 200 with `problems: []` and `error: 'Could not read CI results from GitHub: <reason>'`. Results are cached in memory per `repo#pr@headSha` for 60 s while CI is pending, and until restart once it is not.
  - `POST /api/pr/:owner/:name/:pr/problems/marks`, body `{ key: string (1-1000 chars); mark: 'real' | 'not' | null }`, 204.
  - `getProblems(repo, pr): Promise<ProblemsResponse>` and `setProblemMark(repo, pr, key, mark): Promise<void>` in `src/web/api.ts`.

- [ ] **Step 1: Write the failing tests**

Store: `it('stores, reads and clears problem marks')`.
Routes: `it('GET problems returns CI problems for the tour head commit')` (assert `checkRuns` was called with the tour's `headSha`, not the PR's); `it('says when the tour is outdated')`; `it('a GitHub failure is a note, not an error')`; `it('POST marks stores and clears a mark')`; `it('POST marks rejects a bad body')` (400).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/server/store.test.ts test/server/review-routes.test.ts`

- [ ] **Step 3: Implement the migration, store methods, routes, types and web calls**

- [ ] **Step 4: Run the tests and `npm run check`**

- [ ] **Step 5: Commit**

`git commit -m "feat: serve possible problems and store marks"`

---

### Task 4: Problems in the web app and the overview list

**Files:**
- Create: `src/web/useProblems.ts`, `src/web/ProblemsContext.tsx`, `src/web/PossibleProblems.tsx`
- Modify: `src/web/TourView.tsx` (provider), `src/web/Overview.tsx` (list above the flows), `src/web/styles.css`
- Test: `test/web/use-problems.test.tsx` (new), `test/web/overview.test.tsx`

**Interfaces:**
- Consumes: Task 1 functions; `getProblems`, `setProblemMark` (Task 3); `ReviewThread.bot` (Task 2); `review.threads` from `useReview`.
- Produces:
  - `useProblems(repo: string, pr: number, tour: Tour | null, threads: ReviewThread[]): ProblemsValue`.
  - `type ProblemsValue = { problems: PlacedProblem[]; markOf: (key: string) => 'real' | 'not' | undefined; setMark: (key: string, mark: 'real' | 'not' | null) => void; loading: boolean; pending: boolean; outdated: boolean; note: string | null; error: string | null }`. `problems` = `sortProblems(tour, placeProblems(tour, mergeProblems([...ci, ...bot])))`, where `bot` comes from threads with `bot && !resolved && !outdated`: `{ key: 'bot|' + thread.id, level: botLevel(body), title: botTitle(body), sources: [author name without '[bot]', with a capital: 'coderabbitai' → 'CodeRabbit' via a small name table, else the login], at: line or file from the thread, url: first comment url, threadId }`. `setMark` is optimistic like `useSeenMarks`; a failed save takes it back and sets `error` (`Could not save the mark: <reason>`).
  - `ProblemsContext` (default: an empty `ProblemsValue`) and `useProblemsContext()`.
  - `PossibleProblems({ tour, onVisit }: { tour: Tour; onVisit: (homeId: string, at?: { file: string; line: number }) => void })`, reading the context.

Overview copy and look (spec "The overview", mockup A):
- Heading `Possible problems (N)`, count line `1 likely bug · 2 risks · 1 worth a look` (only levels with a count, `likely bugs` / `risks` plural).
- A card per problem: level chip, title, `why` (muted), where (`Flow 1 · step 3 · ChargeFee, line 42`; `Foundation · <kind> · <title>`; `<file>, line N` under a sub-heading `Elsewhere in this PR` for unplaced line problems; nothing for PR-wide), source tags, and two toggle buttons `Real problem` / `Not a problem` (`aria-pressed`). Marked `not` → dimmed, moved to the end of its level.
- A where-link opens the home as a visit (the overview's existing `onVisit`), at the line when there is one.
- PR-wide problems with a `url`: the title links to the CI run (`target="_blank" rel="noreferrer"`, through `safeHref`).
- Empty: `No possible problems found.` and muted `Read: CI checks and review bots.`
- Muted notes, when they apply: `Reading CI results…` (loading), `CI is still running; more may come.` (pending), `CI results of newer commits are not shown until the tour is rebuilt.` (outdated), the GitHub error note.

- [ ] **Step 1: Write the failing tests**

`useProblems` (mock `src/web/api.ts`): `it('adds open bot threads and leaves resolved and outdated ones out')`, `it('merges and sorts')`, `it('a failed mark save takes the mark back')`.
Overview (render inside a `ProblemsContext.Provider` with a fixed value): `it('lists possible problems worst first with counts')`, `it('a where-link opens the home as a visit')`, `it('Not a problem dims the card and moves it down')`, `it('lists unplaced line problems under Elsewhere in this PR')`, `it('says when nothing was found')`, `it('shows the outdated and pending notes')`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/use-problems.test.tsx test/web/overview.test.tsx`

- [ ] **Step 3: Implement the hook, context, list and wiring**

`onVisit` gains an optional line: extend TourView's `visitHome(homeId, back, at?)` so the step opens with the line shown, using the same jump the review panel uses.

- [ ] **Step 4: Run the tests and `npm run check`; look at it on screen** (desktop and 600 px).

- [ ] **Step 5: Commit**

`git commit -m "feat: list possible problems on the overview"`

---

### Task 5: Problems in the code and at the top of the step

**Files:**
- Create: `src/web/ProblemCard.tsx` (the under-the-line card and the step band share it)
- Modify: `src/web/CodeView.tsx` (rows), `src/web/code-lines.ts` (`problemRows`), `src/web/StepPane.tsx` (band), `src/web/Thread.tsx` (bot chip and marks), `src/web/styles.css`
- Test: `test/web/codeview-review.test.tsx`, `test/web/problems-in-code.test.tsx` (new), `test/web/thread.test.tsx`

**Interfaces:**
- Consumes: `useProblemsContext()` (Task 4), `rowOf`, `threadRows` pattern in `code-lines.ts`.
- Produces:
  - `problemRows(rows: Row[], problems: PlacedProblem[], file: string): Map<number, PlacedProblem[]>`: line problems of `file` without a `threadId` (bot problems show as their thread), keyed by row index via `rowOf`. Rows with problems stay unfolded, like rows with threads.
  - `ProblemCard({ problem, onComment, readOnly }: { problem: PlacedProblem; onComment?: (text: string) => void; readOnly?: boolean })`: level chip (colour by level), title, why, source tags, and unless `readOnly`: `Real problem`, `Not a problem` (both `aria-pressed`, reading/writing marks via the context) and `Comment`. Marked `not`: collapsed to one line (`Not a problem · <title>`), a click opens it.
  - `Comment` sets the code view's selection to the problem's line and fills the composer with `<title>\n\n<why>` (the existing `typed` ref), so the reviewer edits it as a normal draft.
  - In `Thread.tsx`: a thread that is a problem (its id is a `threadId` in the context) shows the level chip in its head and the two mark buttons; merged sources show as tags.
  - Step band in `StepPane`: problems with `homeId === home.id` and `at.kind` `step` or `file` render as `ProblemCard`s under the step title.
  - The peek's read-only code view shows the cards with `readOnly`.

- [ ] **Step 1: Write the failing tests**

- `it('shows a problem right under its line')` (the card follows the row of line 42 in the DOM).
- `it('keeps the row of a problem unfolded')`.
- `it('Comment opens the composer on that line with the problem text')`.
- `it('Not a problem collapses the card to one line')`.
- `it('a bot thread shows its level and the mark buttons, and no second card')`.
- `it('a failing test shows at the top of its step')`.
- `it('the peek shows problems without buttons')`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/problems-in-code.test.tsx test/web/thread.test.tsx test/web/codeview-review.test.tsx`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and `npm run check`; look at it on screen**

- [ ] **Step 5: Commit**

`git commit -m "feat: show possible problems in the code"`

---

### Task 6: Pins on outline steps and map boxes

**Files:**
- Create: `src/web/ProblemPins.tsx`
- Modify: `src/web/Outline.tsx`, `src/web/FlowMap.tsx` (`Card`), `src/web/TourView.tsx`, `src/web/styles.css`
- Test: `test/web/problem-pins.test.tsx` (new), `test/web/outline.test.tsx`, `test/web/flow-map-view.test.tsx`

**Interfaces:**
- Consumes: `useProblemsContext()` (Task 4).
- Produces:
  - `ProblemPins({ homeId }: { homeId: string })`: one dot per problem placed on `homeId` and not marked `not`, worst first, coloured by level; at most 3, then a `+N` dot. Each dot is a button, `aria-label="<Level>: <title>"`. A click toggles a small popup (`role="dialog"`, `aria-label="Possible problem"`) with a `ProblemCard` (`readOnly`) and `Go to the line` (for line problems), which calls the context's `onGoTo`. Esc, a second click or a click outside closes it.
  - The context value (Task 4) gains `onGoTo?: (p: PlacedProblem) => void`; TourView sets it to open the problem's home at its line (closing the map, as a visit when the map or overview is open).
  - Placement: in the outline `<li>` after the item button; in `.flow-map-card` as a sibling of the box button, at the box's top right. Never inside those buttons.

- [ ] **Step 1: Write the failing tests**

- `it('shows a coloured dot per problem on its outline step and map box')`.
- `it('shows at most 3 dots, then +N')`.
- `it('a pin click opens the popup, not the step')` (`onSelect` / `onOpenStep` / peek not called).
- `it('Go to the line calls onGoTo')`, `it('Esc closes the popup')`.
- `it('a problem marked Not a problem has no pin')`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/problem-pins.test.tsx test/web/outline.test.tsx test/web/flow-map-view.test.tsx`

- [ ] **Step 3: Implement.** Check on screen that pins do not change box sizes, the map's lines, or the outline row height.

- [ ] **Step 4: Run the tests and `npm run check`**

- [ ] **Step 5: Commit**

`git commit -m "feat: pin possible problems on the outline and the map"`

---

### Task 7: The approve reminder

**Files:**
- Modify: `src/web/ReviewPanel.tsx`, `src/web/styles.css`
- Test: `test/web/review-panel.test.tsx`

**Interfaces:**
- Consumes: `useProblemsContext()` (the panel renders inside the provider), `onOpenHome` / `onGoTo`.

Copy: when Approve is chosen, above the unseen list:
- Problems with no mark: section `aria-label="Possible problems not marked"`, `3 possible problems are not marked` (`1 possible problem is not marked`), each: level chip, title, `Go to it` (calls `onGoTo`; for a PR-wide problem, a link to its `url` instead).
- Problems marked `real`: `You marked 1 as a real problem` (`2 as real problems`), same rows.
- The submit button says `Approve anyway` when any of these lists or the unseen list is not empty.

- [ ] **Step 1: Write the failing tests**

- `it('lists unmarked problems above unseen items when approving')` (DOM order; count text).
- `it('lists problems marked real as a last warning')`.
- `it('leaves out problems marked not a problem')`.
- `it('says Approve anyway when problems are open')`; `it('shows nothing when Comment is chosen')`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/web/review-panel.test.tsx`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and `npm run check`**

- [ ] **Step 5: Commit**

`git commit -m "feat: list possible problems before approving"`

---

### Task 8: Check on real PRs (controller, not a subagent)

- [ ] **Step 1:** `npm run build`, start a separate pr-tour on port 4399 with a copy of the user's database (`VACUUM INTO`) in a scratch `PR_TOUR_HOME`.
- [ ] **Step 2:** Open a PR with CI annotations or a failed check, and one with CodeRabbit (or another bot) comments. Check: the list, the cards under lines, the step band, pins, marks across a reload, the approve reminder, light and dark mode, 600 px width.
- [ ] **Step 3:** Fix what is off through the normal review loop. Results and screenshots stay outside this repo.
