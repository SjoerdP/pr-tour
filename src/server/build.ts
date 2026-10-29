import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  homeIds,
  tourBodyJsonSchema,
  TourBodyInputSchema,
  type Range,
  type Tour,
  type TourBody,
  type TourBodyInput,
  type TourMeta,
} from '../shared/tour.js';
import { z } from 'zod';
import { findings } from './analysis/findings.js';
import { applyCheck, checkInput } from './analysis/merge.js';
import {
  applyReview,
  functionCode,
  ReviewAnswerSchema,
  reviewChangeText,
  reviewPrompt,
  type ReviewChange,
} from './analysis/review.js';
import type { FunctionsInput, FunctionsOutput } from './analysis/contract.js';
import type { CheckerResult, runCheck, runFunctions } from './analysis/runner.js';
import { checkTour, contains } from './check.js';
import { lineChanges, parseDiff, type FileDiff, type LineChange } from './diff.js';
import { firstLine, type Runner } from './exec.js';
import type { GitHub, PrSummary } from './github.js';
import { tourPrompt } from './prompt.js';
import type { RepoManager } from './repo.js';
import { StoreError, type Store } from './store.js';

const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;
/** Pass C, Claude's one review of the code check's findings. */
const REVIEW_TIMEOUT_MS = 180_000;
/** How much raw output to keep in `TourBuildError.details`. */
const EXCERPT_CHARS = 4000;

/**
 * A tour could not be built or imported. `message` is short and shown to the
 * user as-is; `details` holds the raw error and output excerpts for the log.
 */
export class TourBuildError extends Error {
  constructor(
    message: string,
    readonly details: string,
  ) {
    super(message);
    this.name = 'TourBuildError';
  }
}

/**
 * Replacing the tour would leave the PR's unsent drafts on an older version: the user must
 * confirm first (`--replace`, or `replace: true` on the API). `drafts` is how many there are.
 */
export class ReplaceNeedsConfirmError extends Error {
  constructor(readonly drafts: number) {
    super(
      `This PR has ${drafts} unsent ${drafts === 1 ? 'draft' : 'drafts'}. Run again with --replace to replace the tour. The drafts are kept; drafts made on an older version will be sent as file-level comments.`,
    );
    this.name = 'ReplaceNeedsConfirmError';
  }
}

/**
 * Throw `ReplaceNeedsConfirmError` when the PR has a tour and unsent drafts and the caller
 * did not say `replace`. Without drafts, replacing needs no confirmation: seen marks carry
 * over by content hash.
 */
export function checkReplace(
  store: Pick<Store, 'getTour' | 'draftCount'>,
  repo: string,
  pr: number,
  replace: boolean,
): void {
  if (replace) return;
  const drafts = store.draftCount(repo, pr);
  if (drafts === 0) return;
  let hasTour: boolean;
  try {
    hasTour = store.getTour(repo, pr) !== null;
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    // A tour that no longer reads is still the tour being replaced: ask.
    hasTour = true;
  }
  if (hasTour) throw new ReplaceNeedsConfirmError(drafts);
}

/** Assign ids by position: `f1`, `F1`, `F1.S1`, `o1.1`. Ids in the input are overwritten. */
export function assignIds(body: TourBodyInput): TourBody {
  return {
    ...body,
    foundations: body.foundations.map((f, i) => ({ ...f, id: `f${i + 1}` })),
    flows: body.flows.map((flow, i) => ({
      ...flow,
      id: `F${i + 1}`,
      steps: flow.steps.map((s, j) => ({ ...s, id: `F${i + 1}.S${j + 1}` })),
    })),
    other: body.other.map((g, i) => ({
      ...g,
      items: g.items.map((item, j) => ({ ...item, id: `o${i + 1}.${j + 1}` })),
    })),
  };
}

/** sha1 of a home's changed lines, in diff order, joined by `\n`. */
export function contentHash(lines: string[]): string {
  return createHash('sha1').update(lines.join('\n')).digest('hex');
}

/**
 * Turn a validated body into a stored tour: assign ids, run the check pass,
 * append the unexplained group (if any) to `other`, and hash every home.
 */
export function finishTour(body: TourBodyInput, meta: TourMeta, files: FileDiff[]): Tour {
  const withIds = assignIds(body);
  const { problems, unexplained } = checkTour(withIds, files);
  const full: TourBody = {
    ...withIds,
    other: unexplained ? [...withIds.other, unexplained] : withIds.other,
  };
  return { ...full, ...meta, check: { problems }, hashes: hashHomes(full, files) };
}

/**
 * The text a changed line is hashed by. Added lines hash as `+text`, deleted lines as
 * `-text`, so adding a line and deleting the same line do not look alike. A file
 * without hunks (binary, pure rename, mode-only, empty) has no line text; it hashes
 * as a marker of its status and paths. Such a home keeps its hash when a binary's
 * content changes, because the diff model does not keep blob ids.
 */
function hashText(change: LineChange, file: FileDiff): string {
  if (change.kind === 'file') return `${file.status} ${file.oldPath} -> ${file.path}`;
  return `${change.kind === 'add' ? '+' : '-'}${change.text}`;
}

function hashHomes(body: TourBody, files: FileDiff[]): Record<string, string> {
  // The same lines and the same `contains` as the check pass, so hashes and check agree.
  const all = files.flatMap((file) => lineChanges([file]).map((change) => ({ change, file })));
  const homesById = new Map<string, Range[]>();
  for (const owner of [
    ...body.foundations,
    ...body.flows.flatMap((flow) => flow.steps),
    ...body.other.flatMap((g) => g.items),
  ]) {
    homesById.set(owner.id, owner.homes);
  }
  const hashes: Record<string, string> = {};
  for (const id of homeIds(body)) {
    const ranges = homesById.get(id) ?? [];
    const texts = all
      .filter((l) => ranges.some((r) => contains(r, l.change, l.file)))
      .map((l) => hashText(l.change, l.file));
    hashes[id] = contentHash(texts);
  }
  return hashes;
}

/**
 * Find the JSON in Claude's answer: the whole answer if it parses as JSON; else
 * the first ```json fenced block; else everything from the first `{` to the last `}`.
 * The whole answer goes first because a valid tour can itself contain a fence in a string.
 */
function extractJson(text: string): string | null {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Not plain JSON: look for it inside prose below.
  }
  const fenced = /```json\s*\n([\s\S]*?)```/.exec(text);
  if (fenced?.[1] !== undefined) return fenced[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

type Parsed = { ok: true; body: TourBodyInput } | { ok: false; error: string };

/** Parse and validate a tour body. The error text is fed back to Claude on retry. */
function parseBody(json: string | null): Parsed {
  if (json === null) return { ok: false, error: 'No JSON object found in the answer.' };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
  const result = TourBodyInputSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      error: `JSON does not match the schema:\n${z.prettifyError(result.error)}`,
    };
  }
  return { ok: true, body: result.data };
}

function excerpt(text: string): string {
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}\n[...]` : text;
}

/** `owner/name` → `owner__name` for file names; repo names are checked by `RepoManager`. */
function slug(repo: string): string {
  return repo.toLowerCase().replace('/', '__');
}

export type TourBuilderDeps = {
  run: Runner;
  repos: Pick<RepoManager, 'ensureWorktree' | 'diffText' | 'mergeBase'>;
  github: Pick<GitHub, 'pr'>;
  store: Store;
  /** The pr-tour data dir; temp diff files go to `<home>/tmp`. */
  home: string;
  /** The Go checker passes; tests inject fakes. A checker that fails never fails a build. */
  checker: { functions: typeof runFunctions; check: typeof runCheck };
};

const NO_GO_FILES = 'no Go files in this PR';

/** Whether the PR touches a `.go` file that still exists at its head (added lines or not). */
function hasGoAtHead(files: FileDiff[]): boolean {
  return files.some((f) => f.status !== 'deleted' && f.path.endsWith('.go'));
}

/** Head-side changed lines of the PR's `.go` files, for the checker's `functions` pass. */
function goInput(files: FileDiff[]): FunctionsInput {
  const byFile = new Map<string, number[]>();
  for (const c of lineChanges(files.filter((f) => f.path.endsWith('.go')))) {
    if (c.kind !== 'add') continue;
    byFile.set(c.file, [...(byFile.get(c.file) ?? []), c.line]);
  }
  return { files: [...byFile].map(([path, lines]) => ({ path, lines })) };
}

/** Builds tours with the user's `claude` CLI, or imports author-made ones, and stores them. */
export class TourBuilder {
  constructor(private readonly deps: TourBuilderDeps) {}

  /** Ask Claude for a tour of the PR, check it, and store it as an `inferred` tour. */
  async build(repo: string, pr: number, onLog: (line: string) => void = () => {}): Promise<Tour> {
    const { summary, worktree, diff, mergeBase } = await this.checkout(repo, pr, onLog);

    const diffPath = join(this.deps.home, 'tmp', `${slug(repo)}-${pr}-${summary.headSha}.diff`);
    const functionsPath = diffPath.replace(/\.diff$/, '.functions.json');
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, diff);
    let body: TourBodyInput;
    try {
      // Pass A: the functions that hold changed lines, so Claude can name them exactly.
      const table = await this.functions(worktree, diff, onLog);
      const hasTable = table !== null && table.functions.length > 0;
      if (hasTable) writeFileSync(functionsPath, JSON.stringify(table, null, 2));
      body = await this.askClaude(
        summary,
        worktree,
        diffPath,
        hasTable ? functionsPath : undefined,
        onLog,
      );
    } finally {
      rmSync(diffPath, { force: true });
      rmSync(functionsPath, { force: true });
    }

    return this.finishAndSave(body, summary, mergeBase, 'inferred', diff, worktree, onLog);
  }

  /** Pass A on a checkout; null when there are no Go files, no checker, or the checker fails. */
  private async functions(
    worktree: string,
    diff: string,
    onLog: (line: string) => void,
  ): Promise<FunctionsOutput | null> {
    const input = goInput(parseDiff(diff));
    if (input.files.length === 0) return null;
    onLog('Finding the changed Go functions');
    let result: CheckerResult<FunctionsOutput>;
    try {
      result = await this.deps.checker.functions(this.deps.run, worktree, input);
    } catch (err) {
      result = { ok: false, problem: (err as Error).message, ms: 0 };
    }
    if (!result.ok) {
      onLog(`Function table skipped: ${result.problem}`);
      return null;
    }
    for (const problem of result.output.problems ?? []) onLog(`Function table: ${problem}`);
    return result.output;
  }

  /** The table of changed Go functions of a PR's head (null: no Go files, no checker). */
  async functionsOf(repo: string, pr: number): Promise<FunctionsOutput | null> {
    const { worktree, diff } = await this.checkout(repo, pr, () => {});
    return this.functions(worktree, diff, () => {});
  }

  /**
   * Run the code check again on the stored tour of a PR, and store the result. It checks the
   * commits the tour was made for, even when the PR has moved on since.
   */
  async recheck(repo: string, pr: number): Promise<Tour> {
    const stored = this.deps.store.getTour(repo, pr);
    if (stored === null) {
      throw new TourBuildError(
        `No tour is stored for ${repo}#${pr}.`,
        'Build or import one first.',
      );
    }
    // `baseSha` is the merge base, so this diff is the tour's own diff.
    const { baseSha, headSha } = stored;
    const worktree = await this.deps.repos.ensureWorktree(repo, pr, baseSha, headSha);
    const diff = await this.deps.repos.diffText(repo, baseSha, headSha);
    const tour = await this.passB(stored, worktree, diff);
    this.deps.store.saveTour(tour);
    return tour;
  }

  /** Pass B: check the tour against the code. Never throws; a failure becomes a problem. */
  private async passB(tour: Tour, worktree: string, diff: string): Promise<Tour> {
    if (!hasGoAtHead(parseDiff(diff))) return applyCheck(tour, null, NO_GO_FILES);
    try {
      return applyCheck(
        tour,
        await this.deps.checker.check(this.deps.run, worktree, checkInput(tour)),
      );
    } catch (err) {
      return applyCheck(tour, null, `the Go check failed: ${(err as Error).message}`);
    }
  }

  /**
   * Validate a tour written by the PR's author (the /tour skill), check it, and store it.
   * Replacing a tour while the PR has unsent drafts needs `replace` (see `checkReplace`).
   */
  async importAuthorTour(
    repo: string,
    pr: number,
    bodyJson: string,
    { replace = false }: { replace?: boolean } = {},
  ): Promise<Tour> {
    // Check the file first: a bad one fails at once, before any fetch or clone.
    const parsed = parseBody(bodyJson);
    if (!parsed.ok) throw new TourBuildError('The tour file is not a valid tour.', parsed.error);
    checkReplace(this.deps.store, repo, pr, replace);
    const { summary, worktree, diff, mergeBase } = await this.checkout(repo, pr, () => {});
    return this.finishAndSave(parsed.body, summary, mergeBase, 'author', diff, worktree, () => {});
  }

  private async checkout(repo: string, pr: number, onLog: (line: string) => void) {
    onLog(`Fetching ${repo}#${pr}`);
    // Keep the caller's spelling of the repo: tours are stored and looked up by it.
    const summary = { ...(await this.deps.github.pr(repo, pr)), repo, number: pr };
    onLog(`Checking out ${summary.headSha.slice(0, 7)}`);
    const worktree = await this.deps.repos.ensureWorktree(
      repo,
      pr,
      summary.baseSha,
      summary.headSha,
    );
    const diff = await this.deps.repos.diffText(repo, summary.baseSha, summary.headSha);
    const mergeBase = await this.deps.repos.mergeBase(repo, summary.baseSha, summary.headSha);
    return { summary, worktree, diff, mergeBase };
  }

  /** Run Claude, and once more with the error if the answer is not a valid tour body. */
  private async askClaude(
    pr: PrSummary,
    worktree: string,
    diffPath: string,
    functionsPath: string | undefined,
    onLog: (line: string) => void,
  ): Promise<TourBodyInput> {
    const jsonSchema = tourBodyJsonSchema();
    let retryError: string | undefined;
    let lastAnswer = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      onLog(
        attempt === 1 ? 'Asking Claude for a tour' : 'Answer was not a valid tour; asking again',
      );
      const prompt = tourPrompt({ diffPath, functionsPath, pr, jsonSchema, retryError });
      lastAnswer = await this.runClaude(
        prompt,
        worktree,
        dirname(diffPath),
        CLAUDE_TIMEOUT_MS,
        'the tour',
      );
      const parsed = parseBody(extractJson(lastAnswer));
      if (parsed.ok) return parsed.body;
      onLog(parsed.error);
      retryError = parsed.error;
    }
    throw new TourBuildError(
      'Claude did not return a valid tour, twice.',
      `${retryError ?? ''}\n\nLast answer:\n${excerpt(lastAnswer)}`,
    );
  }

  /**
   * One `claude -p` run in `worktree`; returns its final answer text. `addDir` is one more
   * directory the file tools may read (the diff's).
   */
  private async runClaude(
    prompt: string,
    worktree: string,
    addDir: string | undefined,
    timeoutMs: number,
    /** What the run is for, as it reads after "before finishing": `the tour`, `the review`. */
    what: string,
  ): Promise<string> {
    // Read-only and predictable:
    // - `--tools` makes Read, Grep and Glob the only tools that exist (no Bash, Edit,
    //   WebFetch), and `--allowedTools` lets them run without a permission prompt.
    // - `--add-dir` lets the file tools read the diff, which lives outside the worktree.
    // - `--strict-mcp-config` with no `--mcp-config` loads none of the user's MCP servers.
    // - `--disable-slash-commands` keeps the user's skills and commands out of the run.
    // - `--no-session-persistence` keeps these runs out of the user's session history.
    // The prompt goes on stdin, not argv: it holds the whole JSON schema.
    const args = [
      '-p',
      '--output-format',
      'json',
      '--tools',
      'Read,Grep,Glob',
      ...(addDir !== undefined ? ['--add-dir', addDir] : []),
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
    ];
    const result = await this.deps.run('claude', args, {
      cwd: worktree,
      input: prompt,
      timeoutMs,
    });
    if (result.code !== 0) {
      const reason = firstLine(result.stderr) ?? `exit code ${result.code}`;
      throw new TourBuildError(
        `Claude failed to run: ${reason}`,
        `claude exited with code ${result.code}\n${excerpt(result.stderr)}\n${excerpt(result.stdout)}`,
      );
    }
    let output: unknown;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new TourBuildError('Claude gave output pr-tour cannot read.', excerpt(result.stdout));
    }
    const { result: text, is_error: isError } = output as { result?: unknown; is_error?: unknown };
    if (isError === true || typeof text !== 'string') {
      throw new TourBuildError(`Claude stopped before finishing ${what}.`, excerpt(result.stdout));
    }
    return text;
  }

  /**
   * Pass C: Claude reviews the findings once and may fix the story; pass B then checks the
   * changed tour. Never throws: on any failure the pass B tour is kept, with a problem line.
   */
  private async passC(
    tour: Tour,
    worktree: string,
    diff: string,
    onLog: (line: string) => void,
  ): Promise<Tour> {
    const list = findings(tour);
    onLog(`Asking Claude to review ${list.length} code check findings`);
    const start = Date.now();
    let changes: ReviewChange[];
    try {
      const prompt = reviewPrompt(tour, list, functionCode(worktree, tour, list));
      const answer = await this.runClaude(
        prompt,
        worktree,
        undefined,
        REVIEW_TIMEOUT_MS,
        'the review',
      );
      const json = extractJson(answer);
      if (json === null) throw new Error('no JSON object found in the answer');
      const parsed = ReviewAnswerSchema.safeParse(JSON.parse(json));
      if (!parsed.success) {
        const why = z.prettifyError(parsed.error).replace(/\s*\n\s*/g, ' ');
        throw new Error(`invalid answer: ${why}`);
      }
      changes = parsed.data.changes;
    } catch (err) {
      const analysis = tour.analysis!;
      onLog(`Review skipped: ${(err as Error).message}`);
      const problem = `the review by Claude failed: ${(err as Error).message}`;
      return {
        ...tour,
        analysis: {
          ...analysis,
          problems: [...analysis.problems, problem],
          review: { ran: false, ms: Date.now() - start, changes: [], problems: [problem] },
        },
      };
    }
    const { tour: reviewed, applied, dropped } = applyReview(tour, changes);
    const ms = Date.now() - start;
    onLog(`Claude made ${applied.length} changes; ${dropped.length} dropped`);
    // Its result is final: there is no second review.
    const checked = applied.length > 0 ? await this.passB(reviewed, worktree, diff) : reviewed;
    const analysis = checked.analysis!;
    const droppedProblems = dropped.map((d) => `a review change by Claude was dropped: ${d.why}`);
    return {
      ...checked,
      analysis: {
        ...analysis,
        problems: [...analysis.problems, ...droppedProblems],
        review: {
          ran: true,
          ms,
          changes: applied.map((c) => reviewChangeText(tour, reviewed, c)),
          ...(droppedProblems.length > 0 ? { problems: droppedProblems } : {}),
        },
      },
    };
  }

  private async finishAndSave(
    body: TourBodyInput,
    pr: PrSummary,
    /** Stored as the tour's `baseSha`: the old side of the diff is this commit, not the base tip. */
    mergeBase: string,
    source: TourMeta['source'],
    diff: string,
    worktree: string,
    onLog: (line: string) => void,
  ): Promise<Tour> {
    onLog('Checking the tour against the diff');
    const finished = finishTour(
      body,
      {
        repo: pr.repo,
        pr: pr.number,
        baseSha: mergeBase,
        headSha: pr.headSha,
        source,
        createdAt: new Date().toISOString(),
      },
      parseDiff(diff),
    );
    onLog('Checking the tour against the code');
    let tour = await this.passB(finished, worktree, diff);
    // Author tours get no extra Claude call: the import prints the findings instead.
    if (source === 'inferred' && findings(tour).length > 0) {
      tour = await this.passC(tour, worktree, diff, onLog);
    }
    this.deps.store.saveTour(tour);
    onLog(`Saved the tour (${homeIds(tour).length} homes, ${tour.check.problems.length} problems)`);
    return tour;
  }
}
