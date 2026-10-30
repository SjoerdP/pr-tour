# pr-tour

A local web app for reviewing GitHub PRs as a guided tour. A Node/TypeScript server and a
React UI, plus a Go checker (`checker/go`) that checks tours against the code. The design
documents are in `docs/superpowers/`; open follow-ups are in `docs/superpowers/plan-3-backlog.md`.

## This repo is public

- Never put real data from private repos in this repo: no PR numbers, function or file names,
  ticket ids, flow topics or tour content. That goes for docs, code comments, tests, commit
  messages and PR texts.
- Use made-up examples instead, like the `acme/loans` repay flow the tests use, or the fixture
  module in `checker/go/testdata/flow`.
- Naming the company is fine. Its code and data are not.

## Testing against a real PR

- Run the build under test as a separate pr-tour with its own data folder and port:
  `PR_TOUR_HOME=<scratch dir> PR_TOUR_PORT=4398 PR_TOUR_NO_OPEN=1 node dist/cli.js`.
  Never use `~/.pr-tour` for tests: it holds the user's own tours, seen marks and drafts.
- Results from real PRs stay outside this repo.

## Quality first

- A change that makes builds faster only counts when tour quality stays the same or improves.
- Claude's output differs per build, so compare at least 3 builds on the same commit and look at
  ranges, not single runs.
- Build-time benchmarks are controlled runs, stored outside this repo, not measured on every build.

## Checks and merging

- Before a PR: `npm run check` (typecheck, lint, format, tests), and in `checker/go`:
  `GOTOOLCHAIN=local go test ./... && go vet ./... && gofmt -l .` (must print nothing).
- `npm run build` also builds the Go checker when Go 1.26 or newer is installed.
- `main` is protected: changes go through a pull request, merged with squash.
- The Go checker loads projects with `GOPROXY=off`, `GOFLAGS=-mod=readonly` and
  `GOTOOLCHAIN=local`. It must never download anything.

## Writing

Docs, PR texts and UI copy use plain English: short sentences, common words, one idea per
sentence. Keep technical details exact.
