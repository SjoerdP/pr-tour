# pr-tour Plan 2: Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Do the whole GitHub review inside pr-tour: see existing review threads in place, reply and resolve, comment on any line or range (incl. suggestions), collect drafts, and send them as one review (Comment / Approve / Request changes) with a reminder of what wasn't seen; plus CI status in the inbox.

**Architecture:** Drafts live locally in SQLite until the user presses Submit. Submit creates a pending review on GitHub, adds every draft to it, and submits it with the chosen event in one server call; if any step fails, the pending review is deleted and the drafts stay. Reads (threads, CI, `viewerDidAuthor`) come from one GraphQL query per PR, separate from the existing `GET /api/pr` (which is polled during builds). All GitHub calls go through the existing injectable `Runner` + `gh api graphql`.

**Tech Stack:** unchanged (TypeScript, Hono, better-sqlite3, zod, React, Vitest).

**Spec:** `docs/superpowers/specs/2026-10-28-pr-tour-design.md` (sections "Review features", "Seen marks and approving", "Own PRs"). Architecture: `docs/architecture.md`.

This is plan 2 of 3. "Changes since your last review" and keeping notes/seen marks across rebuilds stay in plan 3.

## Global Constraints

- Nothing is sent to GitHub until the user presses **Submit review** (or **Resolve / Unresolve** on a thread, which act at once, as on GitHub). Drafts are local only.
- Only text the user typed is posted. Tour text written by Claude is never put into a comment automatically.
- On the user's own PR the only event is **Comment**; Approve and Request changes are disabled in the UI with the reason, and rejected by the server (400).
- A review is submitted against the tour's `headSha` (the code the user actually read), never against a newer head.
- Lines outside the PR diff, or ranges that cross a hunk boundary, become file-level comments that start with the line reference and a quote of the code. The composer says so before the user submits.
- Every new keyboard shortcut also has a button with the key in its tooltip (`withKey` from `src/web/shortcuts.ts`). This plan adds no new shortcuts except `Esc` inside a composer (cancel), which is local to the text field.
- Server guard stays: exact Host match, `X-PR-Tour: 1` on every non-GET, frame headers. Add for non-GET: reject when `Origin` is present and not `http://<host>`, and when `Sec-Fetch-Site` is present and not `same-origin`/`none`.
- GitHub values go in as `gh api` `-f`/`-F` fields, never into query text.
- Follow `docs/architecture.md` (web imports only `src/shared`; named `<Thing>Error`s; short user-facing errors via `CommandError.shortMessage`).

## Review Focus

1. **Submit fails halfway** (gh error after the pending review was created): the pending review is deleted, drafts stay, the UI shows a short error and the drafts are untouched. Test in Task 4 and Task 9.
2. **Comment on lines outside the diff, or a range crossing two hunks, or a deleted file:** becomes a file-level comment with a quote; the composer warns. Tests in Task 1 and Task 8.
3. **The PR got new commits after drafting:** the review is posted with `commitOID = tour.headSha`; threads made on newer commits show as "outdated" where GitHub says so. Tests in Task 4 and Task 5.
4. **A cross-site request to submit** (other site in the same browser): rejected by Host/header/Origin/Sec-Fetch-Site checks. Tests in Task 5.
5. **A PR with more than 100 review threads or more than 100 comments in a thread:** all are fetched (pagination), not silently cut. Test in Task 3.

---

## File Structure

```
src/shared/review.ts        review wire types + commentTarget / fileCommentBody (pure)
src/server/graphql.ts       ghGraphql(run, query, fields) helper (moved from github.ts)
src/server/github.ts        uses graphql.ts; inbox adds ci + viewerDidAuthor
src/server/review-github.ts ReviewGitHub: reviewState (read), submitReview, setResolved (write)
src/server/store.ts         migration 2: drafts table + draft methods
src/server/review-routes.ts registerReviewRoutes(app, deps)
src/server/app.ts           guard additions; mounts review routes; inbox adds ci + drafts
src/web/api.ts              review client functions
src/web/useReview.ts        review state for one PR
src/web/Thread.tsx          one thread (comments, reply draft, resolve)
src/web/Composer.tsx        new comment / reply / edit draft, suggestion helper
src/web/ReviewPanel.tsx     drafts list, body, event, approve reminder, submit
src/web/CodeView.tsx        line selection, inline threads/drafts/composer
src/web/TopBar.tsx          "Review" button with draft count
src/web/StepPane.tsx        fact line: comments / drafts count
src/web/Inbox.tsx           CI column + draft count
```

---

### Task 1: Shared review types and comment placement

**Files:**
- Create: `src/shared/review.ts`
- Test: `test/shared/review.test.ts`

**Interfaces:**
- Consumes: `FileDiff`, `Hunk` (`src/shared/diff.ts`).
- Produces (all exported from `src/shared/review.ts`):
  - `DiffSide = 'new' | 'old'`
  - `ThreadComment = { id: string; author: string; body: string; createdAt: string; url: string }`
  - `ReviewThread = { id: string; path: string; side: DiffSide | null; line: number | null; startLine: number | null; outdated: boolean; resolved: boolean; comments: ThreadComment[] }` — `side`/`line` null means a file-level thread.
  - `DraftComment = { id: number; kind: 'comment'; path: string; side: DiffSide; startLine: number; endLine: number; placement: 'line' | 'file'; quote: string | null; body: string; createdAt: string }`
  - `DraftReply = { id: number; kind: 'reply'; threadId: string; body: string; createdAt: string }`
  - `Draft = DraftComment | DraftReply`
  - `NewDraft = Omit<DraftComment, 'id' | 'createdAt'> | Omit<DraftReply, 'id' | 'createdAt'>`
  - `ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'`
  - `CiStatus = { state: 'success' | 'failure' | 'pending' | 'none'; failing: { name: string; url: string } | null }`
  - `ReviewResponse = { viewerIsAuthor: boolean; threads: ReviewThread[]; drafts: Draft[]; ci: CiStatus }`
  - zod: `NewDraftSchema`, `SubmitBodySchema = { event: ReviewEvent; body: string (max 65536) }`, `DraftPatchSchema = { body: string }`
  - `CommentTarget = { placement: 'line'; side: DiffSide; startLine: number; endLine: number } | { placement: 'file'; quote: string }`
  - `commentTarget(file: FileDiff, side: DiffSide, startLine: number, endLine: number, lineText: (n: number) => string): CommentTarget` — `'line'` only when every line `startLine..endLine` on `side` lies inside ONE hunk of `file` (context or changed); otherwise `'file'` with `quote` = those lines joined by `\n`, max 10 lines then `…`.
  - `fileCommentBody(path: string, side: DiffSide, startLine: number, endLine: number, quote: string, body: string): string` — exactly:
    ```
    **`<path>` <old: >line <start>[–<end>]** (not in the diff)
    > <quote line 1>
    > <quote line 2>

    <body>
    ```
    (`old: ` only when `side === 'old'`; `–<end>` only when `end !== start`.)

- [ ] **Step 1: Write the failing tests:**
  - `line inside a hunk → line placement` (new side, context line in hunk).
  - `range inside one hunk → line placement` with start/end kept.
  - `line outside every hunk → file placement with quote`.
  - `range crossing two hunks → file placement`.
  - `old side uses old line numbers` (deleted line in hunk → line placement on `old`).
  - `quote is cut at 10 lines with …`.
  - `fileCommentBody formats single line, range, and old side` — three exact-string assertions.
  - `NewDraftSchema rejects endLine < startLine and empty body`.
- [ ] **Step 2: Run** `npx vitest run test/shared/review.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/shared/review.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: add review types and comment placement`

---

### Task 2: Drafts in the store

**Files:**
- Modify: `src/server/store.ts` (append migration; add methods)
- Test: `test/server/store.test.ts`

**Interfaces:**
- Consumes: `Draft`, `NewDraft` (Task 1).
- Produces on `Store`:
  - `addDraft(repo: string, pr: number, draft: NewDraft): Draft`
  - `updateDraft(repo: string, pr: number, id: number, body: string): Draft` — throws `StoreError` when the draft does not belong to that PR.
  - `deleteDraft(repo: string, pr: number, id: number): void` (no-op if missing)
  - `drafts(repo: string, pr: number): Draft[]` — oldest first
  - `draftCount(repo: string, pr: number): number`
  - `clearDrafts(repo: string, pr: number, ids: number[]): void`
- Migration 2 (append to `MIGRATIONS`): `CREATE TABLE drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, pr INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT, side TEXT, start_line INTEGER, end_line INTEGER, placement TEXT, quote TEXT, thread_id TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX drafts_pr ON drafts(repo, pr);` Repo keys lowercased like the other tables.

- [ ] **Step 1: Write the failing tests:** `add then list returns both kinds in order`; `update changes body`; `update of another PR's draft throws`; `delete removes one`; `clearDrafts removes only the given ids`; `draftCount`; `repo case is ignored`; `an existing version-1 database migrates and keeps tours and seen marks` (create a v1 DB file with the old schema, open with Store, assert data intact and drafts work).
- [ ] **Step 2: Run** `npx vitest run test/server/store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: store review drafts`

---

### Task 3: Read review state and CI from GitHub

**Files:**
- Create: `src/server/graphql.ts`, `src/server/review-github.ts`
- Modify: `src/server/github.ts` (use `ghGraphql`; inbox nodes gain `ci`), `src/shared/api.ts` (`PrSummary` gains `viewerIsAuthor: boolean`; `InboxPr` gains `ci: CiStatus; drafts: number`)
- Test: `test/server/review-github.test.ts`, `test/server/github.test.ts`

**Interfaces:**
- Produces:
  - `ghGraphql<T>(run: Runner, query: string, fields: string[]): Promise<T>` (moved out of `GitHub.graphql`, same behavior; also throws `GraphqlError` with the first `errors[].message` when the response has `errors` and no `data`).
  - `class ReviewGitHub { constructor(run: Runner) }`
    - `reviewState(repo: string, pr: number): Promise<{ prId: string; viewerIsAuthor: boolean; threads: ReviewThread[]; ci: CiStatus }>`
  - `GitHub.inbox()` and `GitHub.pr()` select `viewerDidAuthor` → `viewerIsAuthor`, and the inbox selects the CI rollup → `ci` on each summary (shared mapping function `ciStatus(rollup)` in `review-github.ts`).
- GraphQL (exact fields): `pullRequest(number:) { id viewerDidAuthor reviewThreads(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated path line startLine diffSide subjectType comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { id author { login } body createdAt url } } } } commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } } }`.
- Mapping: `diffSide RIGHT → 'new'`, `LEFT → 'old'`; `subjectType FILE` or null `line` → file-level (`side`/`line` null); deleted author → `'ghost'`. CI: rollup `SUCCESS → success`, `FAILURE|ERROR → failure`, `PENDING|EXPECTED → pending`, no rollup → `none`; `failing` = first CheckRun with conclusion `FAILURE|TIMED_OUT|CANCELLED|ACTION_REQUIRED` or StatusContext with state `FAILURE|ERROR`.
- Pagination: follow `reviewThreads.pageInfo` until done; for a thread whose comments have `hasNextPage`, fetch the rest with a `node(id:) { ... on PullRequestReviewThread { comments(first: 100, after:) } }` query.

- [ ] **Step 1: Write the failing tests** (fake runner from `test/helpers/fake-runner.ts`, canned GraphQL JSON): `maps line, range, old-side and file-level threads`; `outdated and resolved flags`; `ghost author`; `follows thread pagination (2 pages)`; `follows comment pagination inside a thread`; `ci success / failure with failing link / pending / none`; `viewerIsAuthor`; `GraphqlError on errors without data`; `inbox includes ci and viewerIsAuthor` (github.test.ts).
- [ ] **Step 2: Run** `npx vitest run test/server/review-github.test.ts test/server/github.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: read review threads, ci status and authorship from github`

---

### Task 4: Submit a review and resolve threads

**Files:**
- Modify: `src/server/review-github.ts`
- Test: `test/server/review-github.test.ts`

**Interfaces:**
- Produces on `ReviewGitHub`:
  - `submitReview(args: { prId: string; commitOid: string; event: ReviewEvent; body: string; drafts: Draft[] }): Promise<{ url: string }>`
  - `setResolved(threadId: string, resolved: boolean): Promise<void>` (`resolveReviewThread` / `unresolveReviewThread`)
  - `class ReviewSubmitError extends Error { failedDraftId: number | null }` — short message, e.g. `Couldn't add your comment on src/a.ts: <gh short message>`.
- Order (GraphQL mutations, values as fields): `addPullRequestReview(input: { pullRequestId, commitOID })` → review id; for each draft in order: comments → `addPullRequestReviewThread(input: { pullRequestReviewId, path, body, subjectType: LINE|FILE, line, side: RIGHT|LEFT, startLine?, startSide? })` (line placement; `startLine` only when `startLine < endLine`), file placement → `subjectType: FILE`, `body = fileCommentBody(...)`; replies → `addPullRequestReviewThreadReply(input: { pullRequestReviewId, pullRequestReviewThreadId, body })`; then `submitPullRequestReview(input: { pullRequestReviewId, event, body })` → review url. On any failure after the pending review exists: `deletePullRequestReview(input: { pullRequestReviewId })` (ignore its own failure, log it), then throw `ReviewSubmitError`.

- [ ] **Step 1: Write the failing tests:** `submits drafts in order then the event` (assert the exact mutation sequence and fields: line, range with startLine, old side LEFT, file-level body text, reply); `uses commitOID from args`; `failure on the 2nd draft deletes the pending review and reports that draft`; `failure on submit deletes the pending review`; `body text never interpolated into query` (query strings contain no draft text); `setResolved true/false uses the right mutation`.
- [ ] **Step 2: Run** `npx vitest run test/server/review-github.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: submit reviews and resolve threads on github`

---

### Task 5: Review routes and guard hardening

**Files:**
- Create: `src/server/review-routes.ts`
- Modify: `src/server/app.ts` (guard; mount; inbox `ci` + `drafts`), `src/cli.ts` (wire `ReviewGitHub`)
- Test: `test/server/review-routes.test.ts`, `test/server/app.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; existing `prParams`, `HttpError`, `requireTour`.
- Produces: `registerReviewRoutes(app: Hono, deps: { review: ReviewGitHub; store: Store; github: GitHub }): void` with routes under `/api/pr/:owner/:name/:pr`:
  - `GET /review` → `ReviewResponse` (drafts from store).
  - `POST /drafts` body `NewDraftSchema` → `201 Draft`. For `kind: 'comment'` the server re-checks placement with `commentTarget` against the tour's diff and the head/base file text (the client's placement is not trusted); `quote` comes from the server.
  - `PATCH /drafts/:id` body `DraftPatchSchema` → `Draft`; `DELETE /drafts/:id` → `204`.
  - `POST /review/submit` body `SubmitBodySchema` → `{ url }`. Requires a tour (404). Own PR + event ≠ `COMMENT` → 400 `"You can't approve or request changes on your own PR."`. `body` empty and no drafts and event `COMMENT` → 400 `"Nothing to send."`. Uses `commitOid = tour.headSha`. On success clears exactly the submitted drafts. `ReviewSubmitError` → 502 with its message and `failedDraftId`.
  - `POST /threads/:threadId/resolve` body `{ resolved: boolean }` → `204`.
- Guard (all non-GET): existing checks plus `Origin` (if present) must equal `http://` + the request Host, and `Sec-Fetch-Site` (if present) must be `same-origin` or `none`; else 403.
- Inbox rows gain `ci` (from the inbox query) and `drafts` (`store.draftCount`).

- [ ] **Step 1: Write the failing tests:** `GET review returns threads, drafts, ci`; `POST draft recomputes placement server-side` (client says line, server says file + quote); `PATCH/DELETE drafts`; `submit own PR with APPROVE → 400`; `submit with nothing → 400`; `submit uses tour headSha and clears only submitted drafts`; `submit failure → 502 with failedDraftId, drafts kept`; `resolve`; `cross-origin POST → 403`; `Sec-Fetch-Site cross-site → 403`; `same-origin POST with header → OK`; `inbox has ci and drafts`.
- [ ] **Step 2: Run** `npx vitest run test/server/review-routes.test.ts test/server/app.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: review api routes and stricter write guard`

---

### Task 6: Web review client and state

**Files:**
- Modify: `src/web/api.ts`
- Create: `src/web/useReview.ts`
- Test: `test/web/api.test.ts`, `test/web/use-review.test.tsx`

**Interfaces:**
- Produces in `api.ts`: `getReview(repo, pr): Promise<ReviewResponse>`, `addDraft(repo, pr, draft: NewDraft): Promise<Draft>`, `updateDraft(repo, pr, id, body): Promise<Draft>`, `deleteDraft(repo, pr, id): Promise<void>`, `submitReview(repo, pr, event, body): Promise<{ url: string }>`, `setResolved(repo, pr, threadId, resolved): Promise<void>` (all non-GET with `X-PR-Tour: 1`; `ApiError` carries `failedDraftId` when present).
- `useReview(repo: string, pr: number)` returns `{ state: 'loading' | 'ready' | 'error'; error?: string; viewerIsAuthor; threads; drafts; ci; threadsFor(path: string): ReviewThread[]; draftsFor(path: string): Draft[]; add(d: NewDraft); update(id, body); remove(id); submit(event, body): Promise<{ url } | null>; resolve(threadId, resolved); reload() }`. Mutations update state from the server's response (no optimistic drafts). After a successful submit it reloads.

- [ ] **Step 1: Write the failing tests:** api functions send the right method/path/header/body; `useReview` loads, filters by path, add/update/remove update state, submit success reloads and returns url, submit failure keeps drafts and exposes the error + `failedDraftId`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat: web review client and state hook`

---

### Task 7: Thread and composer components

**Files:**
- Create: `src/web/Thread.tsx`, `src/web/Composer.tsx`
- Modify: `src/web/styles.css` (tokens only; match the current calm style)
- Test: `test/web/thread.test.tsx`, `test/web/composer.test.tsx`

**Interfaces:**
- `Thread({ thread, drafts, viewerIsAuthor, onReply(body), onEditDraft(id, body), onDeleteDraft(id), onResolve(resolved) })` — comments (author, relative time, body as plain text with line breaks; ```` ```suggestion ```` blocks shown as a code block labeled "Suggested change"), "outdated" / "resolved" labels, resolved threads collapsed to one line ("Resolved · N comments") and expandable, pending reply drafts labeled "Pending", buttons: Reply, Resolve / Unresolve.
- `Composer({ target: CommentTarget, path, suggestFrom: string[] | null, initial?: string, submitLabel, onSubmit(body), onCancel })` — textarea (autofocus), `Esc` cancels when empty or after confirm, `Ctrl/Cmd+Enter` submits; when `target.placement === 'file'` a notice: "Line N is not in the diff. This will be sent as a file-level comment quoting the line." (range: "Lines N–M are…"); "Suggest change" button only when `target.placement === 'line'` and `suggestFrom` is set: inserts ```` ```suggestion\n<lines>\n``` ```` at the cursor. Buttons are buttons; submit disabled while body is blank.

- [ ] **Step 1: Write the failing tests:** thread renders comments, labels, collapsed resolved state, suggestion block; reply/resolve callbacks; pending reply draft edit/delete; composer file-level notice (single/range), suggestion button presence and inserted text, Esc/Ctrl+Enter, blank-disabled.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat: thread and comment composer components`

---

### Task 8: Comments in the code view

**Files:**
- Modify: `src/web/CodeView.tsx`, `src/web/code-lines.ts`, `src/web/StepPane.tsx` (pass review), `src/web/TourView.tsx` (own `useReview`)
- Test: `test/web/codeview-review.test.tsx`

**Interfaces:**
- `CodeView` gains prop `review: ReturnType<typeof useReview>`.
- `code-lines.ts` adds `threadRows(rows: Row[], threads: ReviewThread[]): Map<number, ReviewThread[]>` (row index after which a thread is shown: new side by `newNo === line`, old side by `oldNo === line`; outdated or unplaceable threads → `-1` = shown in a "Comments on this file" block above the code) and `draftRows(rows, drafts)` likewise for `DraftComment`s.
- Behavior:
  - Each line-number cell is a button "Comment on line N" (hover shows a `+`). Click selects that line; Shift+click extends to a range on the same side. The composer opens under the last selected row with `target = commentTarget(...)` computed from the current `FileDiff` and row texts, and `suggestFrom` = the selected new-side lines.
  - Existing threads render inline after their row (`Thread`), file-level/outdated ones in the top block. Draft comments render inline as "Pending" cards with edit/delete.
  - Threads and drafts inside folds force that fold open (same as changes).
  - Binary files: only the top block (file-level comments) and an "Add file comment" button.

- [ ] **Step 1: Write the failing tests:** click line → composer with line target; shift-click range; line outside diff → file-level notice; submitting the composer calls `review.add` with the right `NewDraft`; inline thread at the right row (new and old side); outdated thread in top block; draft shown as Pending and editable; fold containing a thread opens; binary file comment.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat: comment on lines and show threads in the code view`

---

### Task 9: Review panel, approve reminder and top bar

**Files:**
- Create: `src/web/ReviewPanel.tsx`
- Modify: `src/web/TopBar.tsx`, `src/web/StepPane.tsx` (fact line), `src/web/TourView.tsx`, `src/web/homes.ts`
- Test: `test/web/review-panel.test.tsx`, `test/web/main-screen.test.tsx`

**Interfaces:**
- `homes.ts` adds `unseenForReview(tour, isSeen): Home[]` — reviewable homes not seen, read-closely first, then display order.
- Top bar: a "Review" button (primary style when drafts > 0) showing the draft count ("Review · 3"); opens `ReviewPanel` as a right-side panel (closes on Esc only when focus is inside it, on outside click, and with its Close button; navigation does not close it).
- `ReviewPanel({ review, tour, isSeen, onOpenHome })`:
  - Drafts list (file:line or "reply in <path>"), each jumps to its place (`onOpenHome` for the home owning that line, else opens the file via the existing jump) and can be deleted.
  - Unresolved threads list with jump links.
  - Summary textarea.
  - Event radio: Comment / Approve / Request changes; Approve and Request changes disabled on own PR with "You can't approve your own PR on GitHub."
  - Approve reminder (only when Approve is chosen and something is unseen): "You haven't seen N items" with read-closely items first, each a "Go to it" link; the Submit button then reads "Approve anyway".
  - Submit → `review.submit(event, body)`; on success shows "Review sent" with a link to the review URL and closes after the user clicks it or Close; on failure shows the error and, if `failedDraftId`, highlights that draft.
- Fact line in the step header adds "N comments" (threads touching the step's homes) and "N pending" (drafts in them) when non-zero.
- Inbox (`Inbox.tsx`): CI column — "✓ passing" / "✗ failing" (link to `ci.failing.url`, opens in a new tab with `rel="noreferrer"`) / "● running" / "—", and "N drafts" next to progress when > 0.

- [ ] **Step 1: Write the failing tests:** panel lists drafts and threads; own PR disables Approve/Request changes with the reason; reminder lists unseen read-closely first and switches the button label; submit success / failure (+ highlighted draft); top bar count; fact line counts; inbox CI states and failing link; drafts count in inbox.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat: review panel with approve reminder, ci and draft counts`

---

### Task 10: Docs and a read-only real check

**Files:**
- Modify: `README.md` (review usage), `docs/architecture.md` (review module, drafts table, write guard)

- [ ] **Step 1:** Update docs.
- [ ] **Step 2:** `npm run check` and `npm run build` — Expected: PASS.
- [ ] **Step 3: Read-only real check** (no posting): run from the repo build with `PR_TOUR_HOME` = a scratch copy of the DB and a non-default port; `GET /api/pr/<repo>/<pr>/review` on one of the user's PRs that has review comments; verify threads and CI map correctly; create and delete a draft locally. Do **not** call submit or resolve. Report counts only.
- [ ] **Step 4: Commit** `docs: describe reviewing in pr-tour`
- [ ] **Step 5:** The first real submit is done by the user, on a PR of their choice.
