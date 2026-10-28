# pr-tour architecture

Short and practical. Read this before implementing a task from a plan. The
plans in `docs/superpowers/plans/` are the source of truth for _what_ to build;
this document says _where_ it goes and _which rules_ it follows.

## Shape

One TypeScript package, ESM, Node >= 22. Three layers in `src/`:

```
             +-----------------+
             |   src/shared    |   types, zod schemas, pure functions
             +-----------------+   (runs in Node and in the browser)
                 ^          ^
                 |          |
   +-------------+--+   +---+-------------+
   |  src/server     |   |  src/web        |
   |  Hono API, CLIs |   |  React + Vite   |
   |  SQLite, build  |   |  code view      |
   +-------------+---+   +-----------------+
                 ^
                 |
           +-----+-----+
           |  src/cli  |   composition root: wires real deps, starts the server
           +-----------+
```

The server talks to the outside world only through three CLIs (`gh`, `git`,
`claude`), all run through one injectable `Runner`. The browser talks only to
the server's `/api`. The shared layer is the contract between them.

## Layout and ownership

```
src/shared/      Contract between server and web. No I/O, no Node, no React.
  tour.ts        Tour zod schemas + types, homeIds()
  diff.ts        DiffLine / Hunk / FileDiff types (the diff model, also a wire type)
  rows.ts        buildRows / foldRows / changeBlocks (pure; used by the code view)
  api.ts         HTTP wire types: PrSummary, Inbox, TourStatus, Job, PrResponse, ...
src/server/      Everything that runs under Node, flat, one module per concern.
  exec.ts        Runner type, realRunner (execFile), CommandError
  repo.ts        RepoManager: bare-clone cache, worktrees, diff text, file at sha (git)
  github.ts      GitHub: inbox + PR meta (gh api graphql)
  diff.ts        parseDiff, changedLines (parse-diff)
  check.ts       checkTour: every changed line has exactly one home
  prompt.ts      tourPrompt text
  build.ts       TourBuilder: run claude, validate, assign ids, check, store
  store.ts       Store: SQLite (tours, seen marks)
  jobs.ts        Jobs: in-memory build jobs
  app.ts         createApp: Hono routes, localhost guard, static web app
src/cli.ts       pr-tour binary: parseArgs + wiring of real dependencies
src/web/         React app. Components PascalCase.tsx, hooks useX.ts, api.ts client.
test/            Vitest tests mirroring src/ (test/server, test/shared, test/web, test/cli.test.ts)
test/fixtures/   Real diffs and canned JSON used by tests (byte-exact, not formatted)
test/helpers/    Shared test helpers for the Node side (fake runner, temp git repo, fixture reader)
test/web/        React tests; this directory runs under jsdom (see Testing)
skill/tour/      The /tour Claude Code skill (shipped in the npm package)
docs/            This file, specs and plans
dist/            Build output: cli.js, server/, shared/ from tsc; web/ from Vite
```

Keep `src/server` flat while it is this size. When a concern outgrows one file
(plan 2 will grow `github.ts` with review mutations, plan 3 will grow
`build.ts`/`store.ts` with tour versions), turn that file into a folder of the
same name with an `index.ts` so import paths stay the same. Do not pre-split.

## Dependency rules

| From                                       | May import                                                      | Never imports                 |
| ------------------------------------------ | --------------------------------------------------------------- | ----------------------------- |
| `src/shared`                               | packages that run in the browser (`zod`)                        | `src/server`, `src/web`, Node |
| `src/web`                                  | `src/shared`, browser packages                                  | `src/server`, Node built-ins  |
| `src/server`                               | `src/shared`, `src/server`, Node packages                       | `src/web`                     |
| `src/cli.ts`                               | `src/server`, `src/shared`                                      | `src/web`                     |
| `test/shared`                              | `src/shared`, Node built-ins (`node:` prefix, to read fixtures) | `src/server`, `src/web`       |
| `test/server`, `test/helpers`, `test/*.ts` | the same as `src/server`                                        | `src/web`                     |
| `test/web`                                 | the same as `src/web`                                           | the same as `src/web`         |

Consequences:

- A type the web needs from the server (anything an `/api` route returns)
  lives in `src/shared`, and the server imports it from there. `src/shared/api.ts`
  is where the wire types go; `src/shared/diff.ts` holds the diff model.
- Server code always imports Node built-ins with the `node:` prefix.
- All relative imports end in `.js` (NodeNext). There are no path aliases:
  the server runs as plain Node ESM from `dist/`, and aliases would need a
  second resolver in every tool.

These rules are enforced by ESLint (`no-restricted-imports` per directory in
`eslint.config.js`) and by the TypeScript split: `tsconfig.web.json` has the
DOM lib and no Node types; `tsconfig.server.json` has Node types and no DOM.
`npm run lint` fails on a violation with a message that names the rule.

## External commands behind `Runner`

`gh`, `git` and `claude` are the only ways out of the process. They are never
called directly. Every module that needs one takes a `Runner` in its
constructor:

```ts
type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;
```

- `realRunner` (in `src/server/exec.ts`) wraps `execFile`. It never throws on
  a non-zero exit; it returns `code`. Callers decide what a failure means and
  throw `CommandError` (message includes the command and stderr).
- Tests pass a fake runner: a function that answers from canned output and
  records the calls it saw. `RepoManager` is the exception: its tests use
  `realRunner` against a real temporary git repository, because git's real
  behaviour (merge-base diffs, worktrees, refs) is what is being tested.
- `src/cli.ts` is the only place that constructs the real dependencies
  (`realRunner`, `RepoManager`, `GitHub`, `Store`, `TourBuilder`, `Jobs`) and
  hands them to `createApp`. Nothing else instantiates them.
- Secrets and logins are the user's own `gh` and `claude` sessions. The tool
  stores no tokens.

## Error handling

- Expected failures are classes that extend `Error`, named `<Thing>Error`,
  with `this.name` set, defined next to the code that throws them
  (`CommandError` in `exec.ts`, `TourBuildError` in `build.ts`). Throw them;
  do not return result objects. The one exception is `Runner`, which reports
  the exit code instead of throwing, so callers can interpret it.
- Validation uses zod at the boundaries: Claude's output
  (`TourBodyInputSchema`), imported tour files, and request bodies. Inside the
  server, trust the types.
- The HTTP layer (`app.ts`) maps errors to JSON `{ error: string }`: known
  error classes to a 4xx/5xx that fits, anything else to 500. The web shows
  `error` text as-is; it never has to parse it.
- Build jobs (`jobs.ts`) catch the builder's error and keep it as
  `job.error`; nothing partial is stored (`build.ts` saves only after the
  check pass).
- Never swallow an error silently. Either handle it (and say so in a comment)
  or let it propagate.

## Testing

- Framework: Vitest with two projects (`vitest.config.ts`):
  `node` runs `test/**/*.test.ts` except `test/web`; `web` runs
  `test/web/**/*.test.{ts,tsx}` under jsdom with `@testing-library/react`
  and `test/web/setup.ts` (automatic `cleanup`). Pick the environment by
  putting the file in the right directory; no per-file comments.
- Tests mirror `src/`: `src/server/diff.ts` is tested by
  `test/server/diff.test.ts`. Fixtures live in `test/fixtures/` and are read
  with `readFileSync(new URL('../fixtures/x.diff', import.meta.url), 'utf8')`
  (JSON fixtures too: JSON imports need import attributes under NodeNext and
  are not worth the noise). Tests of shared code may use Node built-ins for
  this; the code under test in `src/shared` may not.
- Helpers used by more than one test file (a fake `Runner`, a temporary git
  repository, a fixture reader) live in `test/helpers/` and follow the server
  layer's rules: Node is fine, `src/web` is not. Web tests keep their helpers
  in `test/web/` (like `setup.ts`), because that directory is typechecked with
  the DOM lib and no Node types.
- Unit tests are the default: pure functions (`diff`, `check`, `rows`,
  `tour`) are tested directly on their inputs and outputs.
- Git code (`RepoManager`) is tested against real temporary repositories
  created in the test (`fs.mkdtempSync`, `git init`, commits with
  `-c user.name=test -c user.email=test@example.com`). Clean up in
  `afterEach`.
- `gh` and `claude` are never run in tests. Use a fake `Runner`.
- No network in tests, ever. If a test needs a remote, it is a local bare
  repository.
- HTTP routes are tested with `app.request(...)` from Hono and fake
  dependencies (plain objects with the same methods), not a listening server.
- Web components are tested with testing-library: render, interact, assert on
  what the user sees. Mock `fetch` (or the `api.ts` client) with `vi.fn`.
- Test names say what is true: `renamed: oldPath and path differ`, not
  `test1`. One behaviour per test.
- A test that passes without the code under test is not a test. Write the
  failing test first (the plans say so for every task).

## Naming

- Files: `kebab-case.ts` for modules; `PascalCase.tsx` for React components
  (one component per file, named like the file); `useX.ts` for hooks;
  `<module>.test.ts(x)` for tests.
- Types and classes `PascalCase`; functions and variables `camelCase`; zod
  schemas end in `Schema` (`TourSchema`) and the inferred type drops it
  (`Tour`); constants that are configuration `UPPER_SNAKE` only when truly
  constant.
- Environment variables start with `PR_TOUR_` (`PR_TOUR_PORT`, `PR_TOUR_HOME`,
  `PR_TOUR_NO_OPEN`).
- API routes under `/api`, kebab-case paths, `:owner/:name/:pr` params.
- Ids inside a tour follow the plan: `f1`, `F1`, `F1.S1`, `o1.1`, `u1`.
- Commits: short, single line, conventional (`feat:`, `fix:`, `chore:`,
  `docs:`). No attribution trailers.

## Tooling

| What         | Where                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| TypeScript 6 | `tsconfig.json` (base + project list), `tsconfig.server.json`, `tsconfig.web.json`, `tsconfig.build.json` |
| ESLint 10    | `eslint.config.js`: typescript-eslint (type-checked), react-hooks, boundary rules                         |
| Prettier     | `.prettierrc` (single quotes, width 100), `.prettierignore`                                               |
| Vitest 5     | `vitest.config.ts` (two projects)                                                                         |
| Vite 8       | `vite.config.ts` (React plugin, `dist/web`, `/api` proxy)                                                 |
| CI           | `.github/workflows/ci.yml`: typecheck, lint, format check, test, build                                    |
| Node version | `.nvmrc` (22), `engines` in `package.json`                                                                |

TypeScript is strict with `noUncheckedIndexedAccess` (line-number code indexes
arrays a lot; `undefined` must be handled) and `verbatimModuleSyntax` (type
imports are `import type`). The build tsconfig has `files: []` so `tsc` does
not fail while `src/` is still empty.

## How to run

```
npm run dev          server (tsx watch, no browser open) + Vite on :5173 with /api proxied
npm run build        clean, tsc -> dist/, vite -> dist/web
npm test             all tests once;  npm run test:watch  for watch mode
npx vitest run test/server/diff.test.ts      one file (works across projects)
npm run typecheck    both tsconfigs
npm run lint         eslint (type-aware; includes the boundary rules)
npm run format       prettier --write;  npm run format:check  in CI
npm run check        typecheck + lint + format:check + test (run before every commit)
node dist/cli.js     the built binary; `npm i -g .` installs it as `pr-tour`
```

## Decisions and reasons

- **Flat `src/server`, not feature folders.** Plan 1 has ten server modules
  with one concern each. Feature folders would hold one file each. Split a
  file into a folder when it outgrows one concern (see Layout).
- **Tests in `test/`, mirroring `src/`, not colocated.** Everything a test
  needs (tests, fixtures, helpers) stays in one tree, the build tsconfig
  needs no test exclusions, and the two vitest projects are plain directory
  globs. The plan already used this layout; there was no reason strong enough
  to change it.
- **`src/shared/api.ts` and `src/shared/diff.ts` added.** The web renders
  `FileDiff`, `PrSummary`, tour status and job state, so those types must be
  importable from `src/web`. The plan's `HunkLike` structural copy was the
  symptom; one home for wire types is the fix. Server modules import these
  types from shared and re-export them where the plan says they are produced.
- **Four tsconfigs.** Server and web have different globals (Node vs DOM).
  One config with both libs lets `document` typecheck on the server and `fs`
  in the browser. The split catches that at `npm run typecheck`. The build
  config exists so tests and tool configs are typechecked but never emitted.
- **Boundary rules via `no-restricted-imports`.** No resolver plugin needed,
  zero extra dependencies, and the messages say what to do instead. The
  cost is that the rules match import text, so they assume the layout above.
- **No path aliases.** See Dependency rules.
- **`format:check` in `check` and CI.** Formatting drift otherwise lands in
  review diffs. `npm run format` fixes it in one command.
- **`concurrently` for `npm run dev`.** One command that runs the API and
  Vite together is the expected developer experience; `PR_TOUR_NO_OPEN=1`
  stops the server from opening the production URL while Vite is the one to
  use.
- **`index.html` at the repo root.** Vite's default, and what the plan says.
  It ships without a script tag until the web shell exists (Task 11 adds it),
  so `npm run build` works from day one.
