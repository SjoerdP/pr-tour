---
name: tour
description: Build a pr-tour review tour for the PR you just pushed, using what you know about why each change was made. Use when the user says /tour or asks to open the PR in pr-tour.
---

# /tour

You wrote this change, so you know why each part of it exists. Write that down
as a pr-tour tour: the reviewer reads it next to the code, in the order the code runs.

1. **Find the PR.** In the current repo run `gh pr view --json number,url,headRefOid`.
   The repo is `<owner>/<name>` from the URL. If there is no PR, stop and say so.
   Make sure your working tree is at `headRefOid` (pushed, nothing uncommitted on top):
   line numbers in the tour are head line numbers.
2. **Read the rules and the format.** Run `pr-tour rules` and `pr-tour schema`.
   Follow the rules exactly. They are the same rules pr-tour gives Claude when it
   builds a tour itself, so do not work from memory of an older version.
3. **Read the diff.** `gh pr diff <number>` (merge base to head). Every added and
   deleted line in it needs exactly one home.
4. **List the functions.** Run `pr-tour functions <owner/name>#<number>`. It lists the
   functions in the PR. Name each step that is one of those functions in `symbol`
   exactly as listed.
5. **Write the tour body** as one JSON object that matches the schema.
   - For every `why`, use your memory of why you made that change: the reason, the
     trade-off, what the reviewer should check. That is what makes an author tour
     better than an inferred one.
   - For each flow's `why`, say why that flow is in the tour: what the PR changes in it,
     or why the reviewer needs it when it has no changes.
   - Never invent intent you do not have. If you do not remember why something
     changed, say only what it does.
6. **Save and import.** Write the JSON to a temp file
   (`mktemp "${TMPDIR:-/tmp}/pr-tour.XXXXXX"`, which works on Linux and macOS), then run
   `pr-tour import --repo <owner/name> --pr <number> --file <path>`.
   - A zod error means the JSON does not match the schema: fix it and import again.
   - Each `problem: ...` line is a home that is wrong (it overlaps another home, covers
     no changed line, or points at a file outside the PR), or a step whose `"from"` line
     is not inside the step it names. Each `unexplained: ...` line is a run of changed
     lines that no home covers. Each `finding: ...` line is something the code check
     found that you should fix. Handle `finding:` lines like `problem:` lines: fix them
     with what you know and import again.
   - A `note: ...` line is information only (for example "no Go files in this PR").
     Do not try to fix it.
   - Retry at most 2 times. If problems remain, keep the last import and tell the
     user which problems are left.
   - Exit code 2 with `This PR has N unsent drafts. Run again with --replace ...` means
     a tour already exists and the PR has review drafts that are not sent yet. Stop. Tell
     the user how many drafts there are, that the drafts are kept, and that drafts made
     on an older version will be sent as file-level comments. Ask if you should replace
     the tour. Only if the user says yes, run the same import again with `--replace`.
     Never pass `--replace` without the user's yes.
   - That yes holds for the rest of this /tour run. The drafts are still there, so every
     later import in this run (a retry after a zod error or problems) also needs
     `--replace`. Do not ask again.
7. **Open it.** Run `pr-tour open <owner/name>#<number>`. It starts pr-tour in the
   background if it is not running yet, opens the browser and exits; it does not keep
   running in your shell. Give the user the URL it prints.

Never comment on, approve or push to the PR from this skill.
