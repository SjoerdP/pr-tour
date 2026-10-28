# pr-tour: design

Date: 2026-10-28
Status: draft for review

## Why

Most of the code in our PRs is now written by Claude. That makes PRs big. The reviewer checks the design and the big decisions, but not every line. GitHub makes this harder than it needs to be: it shows a diff file by file, in alphabetical order. People understand code by following what runs, not by file name.

pr-tour is a local web tool that shows a PR as a guided tour, in the order the code runs. DB migrations and other foundations come first. Then each flow is walked from its entry point (API endpoint, job, event handler) down through the layers (controller → service → repository). Unchanged steps on the path are shown too. The goal is to understand how the flows work **after** the PR, not just which lines changed.

The tool should replace GitHub as the place where the user reviews PRs. Success means: the user starts using it, keeps improving it, and does not go back to the GitHub review UI. Every time the user has to switch to github.com to finish a review, the tool has failed a little.

## Goals

- Show any PR as a tour: foundations, then flows, then other changes.
- Make it clear where to read closely and where skimming is fine.
- Never hide a change: every changed line has a place in the tour.
- Let the user do the whole review in the tool and send it to GitHub as a real review.
- Give an inbox of PRs waiting for the user's review and the user's own open PRs.

## Non-goals (for now)

- Merging PRs. Merging stays on GitHub.
- Creating PRs, editing PR descriptions, managing labels or reviewers.
- Sharing tours with teammates (see "Later").
- Opening a tour from a link on the GitHub PR (see "Later").
- Jump to definition through a real language server per language.

## Anti-goals

- **Per-step approval.** The user approves the PR once. Steps are never a gate. Forcing step-by-step sign-off brings back the busywork the tool exists to remove, and people click through without reading.
- **A tour that hides changes.** If the tour leaves out changed code, it is worse than the GitHub diff. The check pass (below) exists to prevent this.
- **Fake confidence.** "Why" notes written without the author's context must be marked as inferred, not passed off as the author's intent.

## Users

First user: the person who asked for this, on their own team's repos. Other teammates later. Design for one user on one machine, and don't block multiple users later.

## The tour

A tour has three sections, always in this order.

### 1. Foundations

Changes that flows depend on but that are not steps in a flow:

- DB migrations. Show the resulting schema after the PR, not only the migration diff. Flag whether the old code still works on the new schema during a deploy (old and new code running at the same time).
- Model and schema changes.
- New or changed config and env vars.
- Dependency changes.

### 2. Flows

Each flow starts at an entry point: an API endpoint, a scheduled job, an event or queue handler, a CLI command. It follows the calls down through the layers. Steps on the path that did not change are included, marked unchanged, so the user can follow how the flow works.

Each step has:

- File, symbol (function/method) and line range.
- Changed or unchanged.
- A "why" note: what this step does in the flow and why it changed.
- A risk mark: "read closely" or "skim". Read closely is for money math, auth and permission checks, DB writes, external calls, concurrency, and migrations.
- Side effects: DB writes, events emitted, calls to other services.
- Tests that cover this step, and a warning when none do.

### 3. Other changes

A separate overview for changed code that is not a foundation and not on a flow. It's grouped by kind:

- **Refactors and renames:** many small, same-shaped changes, shown as one summary ("renamed X to Y in 14 files") that can be expanded.
- **Tests:** also linked from the flow steps they cover.
- **Infra, CI, docs.**
- **Generated files** (lock files, snapshots): collapsed by default, skim-only.
- **Unexplained:** changed code that could not be placed anywhere. This group should be empty. Anything in it is shown prominently as a warning.

### Home rule and the check pass

Every changed line in the PR has exactly one **home**: a foundation item, a flow step, or an "other changes" item. A line may also *appear* in other places (e.g. a changed helper shown inside two flows), but its "seen" mark counts in its home.

After a tour is built, a deterministic check pass (plain code, not Claude) compares the tour against the real diff:

- Every changed hunk/line must have exactly one home.
- Changed lines without a home go into "Unexplained".
- Line ranges in the tour that don't match the diff at that commit are flagged.

## How a tour is made

Claude builds the tour. The tool only shows it and checks it.

- **From a session (best case).** Right after Claude has written and pushed a PR, the user runs a Claude Code skill (working name `/tour`) in the same session. Claude still has the context of every change and writes the tour, with author "why" notes. The skill saves the tour into the tool and opens the browser on it.
- **From the tool (any other PR).** For teammates' PRs or older PRs, the tool runs the local `claude` CLI in non-interactive mode on the PR (repo checkout + diff) and asks for the tour as structured JSON. Its "why" notes are marked **inferred**.

**Tours are only built when the user triggers them**: by running `/tour`, or by clicking "build tour" on a PR in the tool. There are no automatic background builds, not for new PRs and not after new pushes. While a tour builds, the tool shows progress. In the inbox, PRs without a tour show "no tour yet" instead of flow counts. After new commits, the tour is marked out of date and the user chooses when to rebuild.

The tour is structured JSON with a defined schema (sections, flows, steps, homes, notes, risk marks, side effects, linked tests, author vs inferred). The exact schema is left to the builder.

### New commits

When new commits are pushed to a PR the user has partly reviewed:

- Keep the user's "seen" marks.
- Flag the steps whose code changed since the user last saw them (like GitHub's "changes since your last review"), and reset their "seen" mark.
- Update the tour for just the changed parts if possible. A full rebuild is fine as a first version, as long as "seen" marks for unchanged code survive.
- *(Claude's call)* Author "why" notes survive for steps whose code did not change. Steps whose code changed get new notes from the rebuild, marked inferred. The tour then shows a hint that the author can run `/tour` again to replace them. So "why" notes are stored per step, and steps are matched across versions by file + symbol.

## Screens

Rough wireframes were made during brainstorming. They're a direction, not a spec.

### Inbox

- **Waiting for my review:** PRs where the user's review is requested.
- **My open PRs:** the user's own open PRs (the user reviews these too, and teammates' comments land here).
- Per PR: title, author, size (+/−), number of flows, CI status, review progress (e.g. "3 of 9 seen", "2 changed since your last look"), whether a tour exists and whether it's author-made or inferred.

### Tour view

- **Left: the tour outline.** Foundations, flows (each with its steps), other changes. Each item shows changed/unchanged, the risk mark, side-effect badges and a "seen" state.
- **Main: the current step.**
  - "Why" note at the top, labeled author or inferred.
  - The **whole file**, not just the hunk. Unchanged parts are folded into bars that can be clicked open. A toggle shows the whole file unfolded. The user can scroll freely.
  - **Prev/next change** buttons that jump between changes within the file, with a counter ("change 2 of 4 in this file").
  - Changes in the same file that belong to another flow or section are labeled as such.
  - A marker where the flow continues to the next step.
  - Clicking a call jumps to its definition, starting with definitions Claude traced into the tour.
  - Covering tests, with a warning when none.
  - Comment box for this step / these lines.
- **Top: review actions.** Approve, Request changes, Comment.
- **Keyboard:** `n`/`p` next/prev change in file, `j`/`k` next/prev step, `f` toggle whole file. Exact keys are up to the builder.

### Seen marks and approving

- A step is marked "seen" when the user moves past it. It's never a gate.
- "Seen" marks let the user stop and resume, and they feed the approve reminder.
- On Approve, the tool shows what was not seen, with "read closely" items first. The user can jump to them or approve anyway.

## Review features (must have in v1)

The tool must cover everything the user does in a GitHub review, so there's no reason to switch:

- Inbox as above, kept up to date.
- Existing review threads shown in place, in the tour and the code view. Reply and resolve.
- Comment on any line or line range, including GitHub "suggestion" blocks.
- Pending review: comments collect into one review, sent as Approve, Request changes, or Comment.
- CI status per PR, with a link to the failing job.
- Changes since the user's last review.

Everything goes to GitHub as normal reviews and comments. Teammates see a normal GitHub review.

- *(Claude's call)* **Comments on lines outside the diff.** GitHub only accepts line comments on lines in the PR diff. Because the tool shows whole files and unchanged flow steps, the user will want to comment elsewhere. Such comments are sent as file-level review comments that start with the line reference and a short quote of the code. The UI shows clearly, before sending, that the comment will become a file-level comment.
- **Own PRs.** GitHub doesn't let the author approve or request changes on their own PR. On their own PRs the user can comment, reply and resolve. "Seen" marks there are just for the user's own tracking.

## Stack (decided)

- **TypeScript** everywhere.
- **Server:** Node, a small local HTTP server. It runs `gh` (using the user's existing `gh` login) for GitHub, `git` for diffs and full file contents, and `claude` CLI in non-interactive mode for building tours.
- **Frontend:** React + Vite. The code view is custom-built on **Shiki** for syntax highlighting, not on a ready-made diff viewer, because of the folds, jump buttons, inline notes and clickable calls.
- **Storage:** one SQLite file in the user's home directory. It holds tours and "seen" marks, keyed by repo, PR and commit SHA.
- **Start:** one command (working name `pr-tour`) that starts the server and opens the browser.
- **Claude Code skill** `/tour` that builds a tour from the current session and hands it to the tool.

## Constraints

- Runs locally only. Code and PR data stay on the user's machine, except for the GitHub API (through `gh`) and Claude (through the user's own `claude` CLI). No other outside services.
- No new tokens or accounts: it reuses the `gh` and `claude` logins.
- Must work for repos in any language. Language knowledge comes from Claude, not from per-language parsers.

## Later

- Share author-made tours with teammates (e.g. attached to the PR), optional, when more people use the tool.
- Open a tour from a link on the GitHub PR.
- Merge from the tool.
- Language-server based jump to definition.

## Left to the builder

- Exact tour JSON schema and the prompt used to build tours.
- How the repo checkout is managed for PRs (worktrees, fetch strategy).
- How the inbox stays up to date (polling interval, etc.).
- Visual design, exact keyboard shortcuts.
- Whether to update tours incrementally after new commits or rebuild them, as long as the "seen" marks rule holds.
