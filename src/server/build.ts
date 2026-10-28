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
import { checkTour, contains } from './check.js';
import { lineChanges, parseDiff, type FileDiff, type LineChange } from './diff.js';
import type { Runner } from './exec.js';
import type { GitHub, PrSummary } from './github.js';
import { tourPrompt } from './prompt.js';
import type { RepoManager } from './repo.js';
import type { Store } from './store.js';

const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;
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
};

/** Builds tours with the user's `claude` CLI, or imports author-made ones, and stores them. */
export class TourBuilder {
  constructor(private readonly deps: TourBuilderDeps) {}

  /** Ask Claude for a tour of the PR, check it, and store it as an `inferred` tour. */
  async build(repo: string, pr: number, onLog: (line: string) => void = () => {}): Promise<Tour> {
    const { summary, worktree, diff, mergeBase } = await this.checkout(repo, pr, onLog);

    const diffPath = join(this.deps.home, 'tmp', `${slug(repo)}-${pr}-${summary.headSha}.diff`);
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, diff);
    let body: TourBodyInput;
    try {
      body = await this.askClaude(summary, worktree, diffPath, onLog);
    } finally {
      rmSync(diffPath, { force: true });
    }

    return this.finishAndSave(body, summary, mergeBase, 'inferred', diff, onLog);
  }

  /** Validate a tour written by the PR's author (the /tour skill), check it, and store it. */
  async importAuthorTour(repo: string, pr: number, bodyJson: string): Promise<Tour> {
    const { summary, diff, mergeBase } = await this.checkout(repo, pr, () => {});
    const parsed = parseBody(bodyJson);
    if (!parsed.ok) throw new TourBuildError('The tour file is not a valid tour.', parsed.error);
    return this.finishAndSave(parsed.body, summary, mergeBase, 'author', diff, () => {});
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
    onLog: (line: string) => void,
  ): Promise<TourBodyInput> {
    const jsonSchema = tourBodyJsonSchema();
    let retryError: string | undefined;
    let lastAnswer = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      onLog(
        attempt === 1 ? 'Asking Claude for a tour' : 'Answer was not a valid tour; asking again',
      );
      const prompt = tourPrompt({ diffPath, pr, jsonSchema, retryError });
      lastAnswer = await this.runClaude(prompt, worktree, diffPath);
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

  /** One `claude -p` run; returns its final answer text. */
  private async runClaude(prompt: string, worktree: string, diffPath: string): Promise<string> {
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
      '--add-dir',
      dirname(diffPath),
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
      timeoutMs: CLAUDE_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new TourBuildError(
        'Claude failed to run.',
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
      throw new TourBuildError('Claude stopped before finishing the tour.', excerpt(result.stdout));
    }
    return text;
  }

  private finishAndSave(
    body: TourBodyInput,
    pr: PrSummary,
    /** Stored as the tour's `baseSha`: the old side of the diff is this commit, not the base tip. */
    mergeBase: string,
    source: TourMeta['source'],
    diff: string,
    onLog: (line: string) => void,
  ): Tour {
    onLog('Checking the tour against the diff');
    const tour = finishTour(
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
    this.deps.store.saveTour(tour);
    onLog(`Saved the tour (${homeIds(tour).length} homes, ${tour.check.problems.length} problems)`);
    return tour;
  }
}
