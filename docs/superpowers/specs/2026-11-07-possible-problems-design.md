# Possible problems: design

Date: 2026-11-07. Status: draft for review. Replaces the "Things to check" and "Pins" sections
of `2026-11-05-pr-overview-and-flow-map-design.md`. That plan
(`docs/superpowers/plans/2026-11-06-things-to-check.md`) is parked and will not be built.

## Why

pr-tour shows what a PR does and how its flows run. It does not yet tell the reviewer where
something could be wrong. The first idea was a list of questions for the reviewer. The user
turned it down: if Claude can answer a question by reading the code, Claude should check it
and say what it found. The reviewer wants signals that something could be wrong, with a
severity.

Not every reviewer or team wants an AI to look for problems. Many teams already run tools
that do: review bots (CodeRabbit, Copilot review), linters and scanners in CI (golangci-lint,
eslint, CodeQL, Semgrep), and tests. Their findings are spread over the GitHub PR page, far
from the code they are about.

So pr-tour becomes **the place where every warning about a PR shows up next to the code it is
about**, in the flow it belongs to, with a severity. Claude is one source of warnings among
several, and an optional one.

## Goals

1. One kind of thing, a **possible problem**: a source, a severity, a title, a reason, and
   where it is (a line, a step, or a file).
2. Possible problems are shown:
   - on the overview, as one list, worst first, above the flows (mockup A);
   - in the code, right under the line they are about, like a review comment;
   - at the top of a step, when they are about the step as a whole (a failing test);
   - as coloured pins on outline steps and map boxes.
3. The reviewer marks each one "Real problem" or "Not a problem", and can turn one into a
   review comment.
4. Approving with possible problems that are not marked lists them in the approve reminder.
5. Sources, in build order:
   1. **GitHub**, with no setup: failing CI tests, CI line annotations (linters, scanners),
      and review comments by bots.
   2. **Claude**, optional: a separate pass after the tour is built.
   3. **Other tools**, later: `pr-tour problems import`, so skills and scripts can add their
      own.

## Non-goals (for now)

- Questions for the reviewer ("Needs your judgement"). Dropped with the "Things to check"
  design. May come back later if Claude's pass shows a real need.
- Running linters or scanners from pr-tour. pr-tour reads what CI already ran.
- Calling outside services such as the CodeRabbit API. Only GitHub, through the user's own
  `gh` login, which pr-tour already uses.
- Sharing "Real problem" / "Not a problem" marks with a team. They are local, like seen marks.
- Blocking the approve. The reminder lists; approving anyway stays possible.

## Anti-goals (a failure even if it works)

- **Noise.** A list where most warnings are wrong or trivial teaches reviewers to ignore it.
  Claude's pass must prefer few, well-grounded warnings; "nothing found" is a normal answer.
- A warning shown as fact when it is a guess. Claude's warnings say "can" or "could" unless
  the code shows it; every warning names where it is and why.
- The same finding shown twice: once as a bot's review thread and once as a warning, or twice
  because two tools found it.
- A warning on the wrong line: annotations for another commit shown on the tour's code.
- Claude's pass making tours worse or builds fail. The tour prompt does not change; the pass
  runs after the tour is saved and its failure is a note, never a failed build.
- A slower overview. The list loads with the PR or after it; it never holds up the tour.

## Severity

Three levels, the same for every source:

| Level | Colour | Means |
|---|---|---|
| **Likely bug** | red | It goes wrong, and the source can point at where: a failing test, a scanner error, Claude showing the lines. |
| **Risk** | orange | It can go wrong under some conditions: failures, concurrency, deploy order, input. |
| **Worth a look** | blue | Not wrong as far as the source can tell, but fragile, unclear or against a rule (most lint warnings). |

How each source maps (builder's call where the source has no levels; this is the default):

- A failed CI check run: Likely bug, whether or not its tests can be placed on steps.
- CI annotations: `failure` → Likely bug, `warning` → Risk, `notice` → Worth a look.
- Bot review comments: Worth a look, unless the bot marks its own level in a way the builder
  can read reliably (CodeRabbit labels such as "Potential issue" → Risk). The builder lists
  the bots and labels it maps.
- Claude: its own choice of level, under the definitions above, which the prompt gives.

## Where a problem is

A possible problem points at one of:

- **a line**: a file and a head line (`side: new`), or a base line (`side: old`) for deleted
  code;
- **a step**: a failing test listed in a step's `tests` points at that step;
- **a file**: a file of the PR, when the source names no line.

pr-tour places it in the tour: the home whose changed lines or step range hold that line
(steps first, then foundations, then other items). A line in no home is shown on the overview
list under "Elsewhere in this PR" with its file and line, and opens the file in the code view
when the file is in the PR. Problems about files outside the PR are not shown.

## The overview (mockup A)

Above "Flows in this PR":

- Heading `Possible problems (N)` and a count line: `1 likely bug · 2 risks · 1 worth a look`.
- One card per problem, worst level first, then tour order. Each card:
  - the level chip, the title (one line), the reason (muted, one or two lines);
  - where: `Flow 1 · step 3 · ChargeFee, line 42`, `Foundation · migration · <title>`, or a
    file and line; a click opens it as a visit, with the way back to the overview;
  - the sources as small tags (`Claude`, `CodeRabbit`, `golangci-lint`, `CI tests`); merged
    duplicates show all their sources;
  - "Real problem" and "Not a problem". A problem marked "Not a problem" stays in the list,
    dimmed, at the end of its level.
- With no problems: `No possible problems found.` and, in muted text, which sources were read
  (for example `Read: CI checks, review bots. Claude's check is off for this repo.`).
- While a source is still loading or CI is still running: a muted line says so; the list fills
  in when it is ready.

## In the tour

- **Under the line.** A problem about a line shows right under that line in the code view, in
  its level's colour, like a review thread: level chip, title, reason, sources, and the
  buttons "Real problem", "Not a problem", "Comment". "Comment" opens the comment box on that
  line with the warning's text filled in, as a draft the reviewer edits before it is sent.
- **Bot review comments are not shown twice.** A bot's review thread keeps showing as the
  thread it is (with its replies), and gets the level chip and the two mark buttons. It is not
  drawn a second time as a warning.
- **Top of the step.** A problem about the whole step (a failing test) shows as a band under
  the step title, with a link to the test's file when the test file is in the PR, else to the
  CI run on GitHub.
- **Pins.** A coloured dot per problem on the step's outline row and on its map box (red,
  orange, blue; at most 3 dots, then `+N`). A click shows the problem in a small popup with
  "Go to the line". Pins are separate buttons, never inside the box or row button, so a pin
  click does not open the step.
- Problems marked "Not a problem" lose their pin and show collapsed under the line (one line,
  click to open).

## Merging duplicates

Two problems are one when they point at the same file and a line within 2 lines of each
other, and both are of the same kind of claim. pr-tour cannot compare claims reliably, so the
rule is (builder may refine): same file, lines within 2, and at least one source is Claude or a
bot (free text). Two linter annotations on the same line stay separate. The merged problem takes
the highest level and lists every source; each source's own text is one click away.

## Marks

- "Real problem" / "Not a problem" are stored per repo, PR and problem, in the local
  database. A problem's identity is built from what it says, never from GitHub ids (check runs
  and annotations get new ids on every commit), so a mark survives a rebuild and a new commit
  while the problem is the same:
  - a line problem: source, file, the text of its line, and its title. When the line's code
    changes, the identity changes and the mark is gone, like a seen mark;
  - a step, file or PR-wide problem (a failed check): source, the check or test name, and the
    title. Its mark is dropped when the head commit changes, as the result is about one run.
  (Designer's call.)
- Marks feed nothing outside the PR for now. Later they can show how often each source was right.

## The approve reminder

When the reviewer picks Approve and there are problems not marked, the reminder lists them
above the unseen items, worst first: `3 possible problems are not marked` (`1 possible
problem`), each with its level, title and "Go to it". Problems marked "Real problem" are listed
too, under `You marked 1 as a real problem`, as a last warning. "Approve anyway" stays.

## Sources

### GitHub (first)

Read through `gh`, for the tour's head commit only:

- **Check runs and their annotations** for the head commit. Annotations with a path and line
  are line problems. Only annotations on lines the PR changed are shown: a linter that reports
  whole files would otherwise flood the list with old warnings. (Designer's call.)
- **Failed check runs.** A failed run that has line annotations is shown through those
  annotations only, not also as a card of its own (no finding twice). A failed run without line
  annotations is one problem. It is placed on a step when a failing test name can be read from
  the run's annotations or output summary and matches a step's `tests`; else it is a PR-wide
  problem at the top of the overview list: `CI check "<name>" fails`, with a link to the run.
  PR 1 reads only annotations and the output summary, never the job logs, so placing a test on
  a step is a bonus that works only when the CI reports test names there. Reading logs for
  `go test` and jest can come later. (Designer's call.)
- **Review threads by bots** (authors GitHub marks as bots, or names ending in `[bot]`): the
  threads pr-tour already loads. Resolved and outdated bot threads are not possible problems:
  they show as threads as today, without a level, and do not count in the list, the pins or the
  reminder. Bot comments outside a thread (review bodies, PR comments) are not read for now.
  (Designer's call.)
- When the PR head moved past the tour's head commit, the tour is already marked outdated.
  Problems are read for the tour's head commit, so lines match the code shown. A muted note
  says CI results of newer commits are not shown until the tour is rebuilt.
- Read when the PR opens and again on reload; cached per head commit while the app runs. A
  failure to read is a muted note, never an error that stops the tour.

### Claude (second, optional)

- A switch where a build starts: `Also look for possible problems (takes a few minutes more)`.
  Remembered per repo in the local database. Off by default.
- `pr-tour import` (author tours) does not run it. A later flag may.
- It runs after the tour is checked and saved, as its own step with its own log line and
  timer. The tour can be read while it runs; its problems appear when it is done.
- Input: the diff, the saved tour (flows, steps, proven links, side effects), and the
  checked-out head to read code from. The prompt asks for:
  - only problems in this PR's change or caused by it;
  - few problems, each with level (defined as in "Severity"), title, reason, file and line;
  - no style, naming or formatting remarks;
  - "nothing found" when nothing is found.
- pr-tour drops a problem whose file is not in the PR or whose line is not in the file at
  head, and says how many it dropped in About this PR.
- Its result is stored with the tour, so it is not paid for again on reload.
- A timeout or error leaves the tour as it is, with a note in About this PR.

### Other tools (later)

`pr-tour problems import --repo <owner/name> --pr <n> --file <path>`: a JSON list in the same
shape (source name, level, title, reason, file, line). It replaces that source's earlier list
for the PR. The format is documented for skill and tool authors.

## Quality

- The tour prompt does not change, so tour quality is not at risk from this design.
- For Claude's pass, before it is merged: run it on at least 3 builds of the benchmark PR.
  Count problems per level and the time it adds. Make a table of every problem side by side;
  the user marks each as real, noise or wrong. The merge is the user's call on that table.
- For GitHub sources: check on screen on real PRs with CI annotations and bot comments, in a
  separate pr-tour (`PR_TOUR_HOME=<scratch dir>`), never `~/.pr-tour`.

## Constraints

- Plain English in the UI and docs; short sentences.
- No real data from private repos in this repo: tests and fixtures use `acme/loans`.
- Only GitHub is called, through `gh`. Nothing about the user goes anywhere new.
- Works for tours from before this change.
- `npm run check` passes; UI checked on screen.

## Build order (pull requests)

1. **Possible problems from GitHub**: the problem model, reading check runs, annotations and
   bot threads, placing them, the overview list, problems under the line and at the top of
   the step, pins, marks, the approve reminder.
   (May be split by the plan: model, sources and overview first; code view, pins and reminder
   next.)
2. **Claude's check**: the switch, the pass, storing its result, the quality gate.
3. **Import** for other tools.

## Left to the builder

- The exact look within the mockups and the existing colour tokens.
- How problems are fetched (with the PR or as a separate request).
- The mapping of bot labels to levels, listed in the plan.
- How marks are stored (new table), within the rules above.
- The exact prompt of Claude's pass, within the rules above (it is reviewed with the quality
  table).
