# pr-tour

Review a pull request as a guided tour, in the order the code runs.

pr-tour shows a PR in three parts: the **foundations** the change builds on
(migrations, models, config, dependencies), the **flows** that follow the code
from an entry point (a route, a job, an event handler) step by step, and the
**other** changes (refactors, tests, infra, docs). Every changed line has exactly
one place in the tour. Lines the tour does not explain are listed under
"Unexplained", so nothing is hidden.

A tour comes from one of two places:

- **Inferred:** pr-tour asks the `claude` CLI to read the diff and the code and build one.
- **By the author:** the PR's author runs `/tour` in Claude Code right after pushing.
  The author knows why each change was made, so the notes say that.

pr-tour runs on your machine only. It listens on 127.0.0.1 and never comments on,
approves or pushes to a PR.

## Requirements

- Node 22 or later
- [`gh`](https://cli.github.com/), logged in (`gh auth status`)
- The [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI, logged in (for inferred tours)
- `git`

## Install

```sh
git clone <this repo> && cd pr-tour
npm install
npm run build
npm i -g .
```

This puts `pr-tour` on your PATH.

### Install the `/tour` skill

```sh
cp -r skill/tour ~/.claude/skills/
```

## Usage

```sh
pr-tour                         # start pr-tour and open the inbox in the browser
pr-tour open owner/name#123     # open the tour of one PR
```

The inbox lists PRs waiting for your review and your own open PRs. Open one and
click **Build tour** to get an inferred tour. In the tour:

| Key       | Does                                              |
| --------- | ------------------------------------------------- |
| `j` / `k` | next / previous stop in the tour                  |
| `n` / `p` | next / previous change                            |
| `f`       | show the whole file, or fold unchanged code again |

Seen marks are saved, so you can stop and come back.

### Author tours with `/tour`

After you push a PR, run `/tour` in the Claude Code session where you made the
change. Claude writes the tour from what it knows about why each change was
made, checks it with `pr-tour import`, and opens it. The tour is labeled
"Notes by the author".

The skill uses these commands, which you can also run yourself:

```sh
pr-tour schema    # the JSON Schema of a tour file
pr-tour rules     # the rules a tour file follows
pr-tour import --repo owner/name --pr 123 --file tour.json
```

`import` prints a `problem: ...` line for each home that is wrong (overlapping, or
pointing at nothing changed) and an `unexplained: ...` line for each run of changed
lines that has no home. No output besides the URL means every changed line has
exactly one home.

### Settings

| Variable          | Default      | Meaning                          |
| ----------------- | ------------ | -------------------------------- |
| `PR_TOUR_PORT`    | `4317`       | port to listen on                |
| `PR_TOUR_HOME`    | `~/.pr-tour` | data dir (clones, tours, seen)   |
| `PR_TOUR_NO_OPEN` | unset        | set to `1` to not open a browser |

## Development

Read [`docs/architecture.md`](docs/architecture.md) first: layers, import rules,
testing and naming.

```sh
npm run dev      # API server + Vite with hot reload
npm run check    # typecheck, lint, format check and tests; run before every commit
```
