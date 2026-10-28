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
