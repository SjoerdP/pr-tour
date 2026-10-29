# Plan 3 backlog (from plan 2 reviews)

Small items found while building plan 2. None blocked the merge.

- Task 1: minor (deferred): commentTarget returns 'line' for reversed range (schema guards it)
- Task 1: minor (deferred): cross-hunk test also spans a gap; no adjacent-hunk fixture
- Task 1: minor (deferred): empty quote line renders "> " with trailing space
- Task 2: minor (deferred): draftOf fills ''/0 for null required columns instead of throwing StoreError
- Task 2: minor (deferred): addDraft returns spread of caller object, not re-read row
- Task 2: minor (deferred): no test that saveTour leaves drafts alone
- Task 3: minor (deferred): pagination silently truncates if hasNextPage && endCursor null (threads + comments)
- Task 3: minor (deferred): GraphqlError->PrNotFoundError branch untested
- Task 3: minor (deferred): store.draftCount in inbox outside StoreError guard (app.ts:87)
- Task 4: minor (deferred): mutate() duplicates ghGraphql call/parse; move to graphql.ts ghMutation
- Task 4: minor (deferred): local shortMessage repeats app.ts userMessage CommandError branch
- Task 4: minor (deferred): rollback failure logged with String(err), thin
- Task 4: minor (deferred): console.error spies restored after asserts (leak on failure); one unneeded spy
- Task 4: minor (deferred): user text "gh failed: gh: ..." doubled prefix
- Task 5: minor (deferred): resolve route doesn't check threadId belongs to PR (passed as -f, guarded)
- Task 5: minor (deferred): no DELETE-other-PR draft test; CRLF quote keeps \r
- Task 6: minor (deferred): a stale reload held by a caller after PR switch could still cancel the new load (nothing does today)
- Task 7: minor (deferred): styles.css orphaned "Narrow windows" comment (new block inserted between comment and @media)
- Task 7: minor (deferred): setBusy after unmount; caret placement untested; resolved-while-open stays open
- Task 8: minor (deferred): deleting the last draft in an unchanged area folds it shut again
- Task 9: minor (deferred): `sent` never cleared — hint stays hidden after a send until panel closes
- Task 9: minor (deferred): null-line fact-line test may pass vacuously
- Task 9: minor (deferred): no browser layout check of the review panel (100dvh calc; covers right 420px)
- Task 10: minor (deferred): web replace check only at request time; drafts added during a long build aren't asked about
- Task 10: minor (deferred): no route test "drafts but no tour → 202"
- Task 10: minor (deferred): confirm not focused/announced; Rebuild tour clickable during confirm
- Task 11: note (deferred): outdated threads have line null → file-level; plan 3 could query originalLine for context
- Task 11: minor (deferred): README Reviewing section a bit dense; architecture.md odd line wrap
- Final: parked — open new comment lost on rebuild (keyed by head) — Ruling: by design, lines may point at other code; notice could be added in plan 3
- Final: parked — Save on an edit opened before submit → 404 shown, text kept — Ruling: rare and visible
- Final: parked — composer memory entries not always removed — Ruling: bounded per page session
- Final: parked — safeHref rejects http CI targets (e.g. self-hosted Jenkins) — Ruling: https-only is the safe default; widen if the user needs it
- Browser check: "Go to it" from the review panel opens the right step but does not scroll to the thread's line.
- Browser check: the review panel covers the right part of the code.
- Browser check: the first click on a line number opens the composer at once, which moves the rows below, so a shift-click must aim at the moved row.
- Comment bodies show raw markdown (plain text by design, Ruling 9).

## Ideas: packaging and editors (brainstorm, 2026-10-29)

Not planned yet. What we found when we looked at each option.

| Option | Keeps all features? | Effort | Notes |
|---|---|---|---|
| Claude Code plugin that installs and starts pr-tour | Yes | About a day | Easiest to share. Teammates run `/plugin marketplace add SjoerdP/pr-tour` and `/plugin install pr-tour@pr-tour`. |
| VS Code / Cursor extension | Yes (level 1 or 2) | 1-2 days for a webview prototype, 1-2 weeks embedded | The only way to have the tour inside the editor. |
| Zed | No | - | Zed extensions are Rust compiled to WebAssembly, with no custom UI (no panels or webviews) yet. Do an "Open in Zed" button per step instead, about half a day. |
| Static page with memory | No | - | No live GitHub, no sending reviews, a snapshot that goes stale. Publishing it would put Tranched code on an outside service. |

They combine well: a plugin for install and sharing, plus "Open in editor" buttons.

### Plugin: what has to change

- Swap `better-sqlite3` for Node's built-in `node:sqlite`. Plugins install npm packages with `--ignore-scripts`, so the native module cannot set itself up. Test that existing databases still open.
- Plugins run no build step. Bundle the server into one JS file (no `node_modules`) and ship the built web UI in the plugin folder, made by an `npm run build:plugin` script.
- Contents: `skills/tour/` (no more copying the skill by hand), `bin/pr-tour`, the built UI, and a `/review <pr>` command that starts pr-tour and opens the PR.
- Keep data in `~/.pr-tour`, not in the plugin folder, so tours, seen marks and drafts survive updates and reinstalls.

### Plugin: still launching pr-tour without Claude

The app does not need Claude: the inbox, reading tours, drafts and sending reviews all work on their own. Only building a tour calls Claude (the "Build tour" button runs the `claude` CLI, or `/tour`).

The catch: a plugin's `bin/` is on the PATH only inside Claude Code's shell, and the plugin's install folder changes on every update, so a fixed link to it breaks. Options:

- Keep `~/.local/bin/pr-tour` pointing at the repo's `dist/cli.js` (works for whoever develops pr-tour).
- Add `pr-tour install-cli`: it writes a small launcher to `~/.local/bin` that always starts the newest installed plugin version (for teammates who only install the plugin).
- Publish to npm (`npm i -g pr-tour`): the most standard, but it is a public release.

### VS Code / Cursor levels

1. Webview: the extension starts the server and shows the current UI in a panel, plus "Open in editor" from a step.
2. Embedded: the server runs in the extension, and the one `fetch` wrapper in `src/web/api.ts` sends messages instead of HTTP. The outline becomes a sidebar tree. Needs files from the PR head (worktree or `git show`), since the workspace may be on another branch.
3. Native: real editor tabs, decorations for the step, VS Code's comments API, "Called from" as a CodeLens. This means rebuilding folds, owner labels, clickable calls and the composer on a more limited API.

Start with 1 to see if reviewing in the editor feels better, then move to 2.
