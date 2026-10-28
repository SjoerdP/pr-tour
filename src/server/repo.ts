import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError, runOk, type Runner } from './exec.js';

const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Refs that keep the base and head commits of every checked-out PR from being garbage-collected. */
const KEEP_REFS = 'refs/pr-tour/';

/**
 * Git options that keep the user's own git config from changing output we parse
 * or from running their hooks:
 * - `core.quotepath=off`: non-ASCII paths come out as-is instead of "\303\274"-quoted.
 * - `core.hooksPath=/dev/null`: `worktree add` does not run a global post-checkout hook.
 * - `credential.https://github.com.helper`: clone and fetch log in to github.com with the
 *   user's `gh` login (what `gh auth setup-git` sets up). Without it, a user whose git
 *   talks to GitHub over ssh has no https credentials and every private repo fails.
 *   The empty value first clears any helper from the user's config.
 */
const GIT_CONFIG = [
  '-c',
  'core.quotepath=off',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'credential.https://github.com.helper=',
  '-c',
  'credential.https://github.com.helper=!gh auth git-credential',
];

/**
 * Plain unified diff whatever the config says: no external diff tool, no textconv
 * filter (from diff.<driver>.textconv and an attributes file), no colour,
 * the standard a/ b/ prefixes (overrides diff.noprefix and diff.mnemonicPrefix),
 * and paths relative to the repo root (overrides diff.relative).
 */
const PLAIN_DIFF = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/**
 * Local git checkouts of PRs, kept in the pr-tour data dir:
 * a bare clone per repo at `<home>/repos/<owner>__<name>.git`
 * and a worktree per head SHA at `<home>/worktrees/<owner>__<name>/<headSha>`.
 */
export class RepoManager {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly home: string,
    private readonly run: Runner,
    private readonly cloneUrl: (repo: string) => string = (repo) =>
      `https://github.com/${repo}.git`,
  ) {}

  /** Make sure `headSha` of PR `pr` is checked out; returns the worktree path. */
  async ensureWorktree(
    repo: string,
    pr: number,
    baseSha: string,
    headSha: string,
  ): Promise<string> {
    const bare = this.barePath(repo);
    checkSha(baseSha);
    checkSha(headSha);
    if (!Number.isInteger(pr) || pr <= 0) throw new Error(`Not a PR number: ${pr}`);
    const path = join(this.home, 'worktrees', slug(repo), headSha);
    // Builds of different PRs in one repo run at the same time; git commands on one
    // bare clone must not overlap (half-written clone, lock files).
    return this.locked(bare, async () => {
      // A worktree has a `.git` file; a directory without one is left over from an
      // interrupted `worktree add` and is made again.
      if (existsSync(join(path, '.git'))) return path;
      rmSync(path, { recursive: true, force: true });

      if (!existsSync(bare)) {
        // `--origin origin` so a user's clone.defaultRemoteName does not rename it.
        await this.git(
          undefined,
          'clone',
          '--bare',
          '--quiet',
          '--origin',
          'origin',
          this.cloneUrl(repo),
          bare,
        );
      }
      if (!((await this.has(bare, baseSha)) && (await this.has(bare, headSha)))) {
        await this.git(
          bare,
          'fetch',
          '--quiet',
          'origin',
          `+refs/pull/${pr}/head:refs/pr/${pr}`,
          baseSha,
        );
      }
      // Give both commits a ref of their own: a base fetched by SHA has none, and
      // `refs/pr/<pr>` moves when the PR is updated. Without a ref, git gc may delete
      // them and an old tour could no longer show its diff.
      for (const sha of [baseSha, headSha]) {
        await this.git(bare, 'update-ref', `${KEEP_REFS}${sha}`, sha);
      }
      // Forget worktrees whose directory was deleted, so `add` does not refuse the path.
      await this.git(bare, 'worktree', 'prune');
      await this.git(bare, 'worktree', 'add', '--quiet', '--detach', path, headSha);
      return path;
    });
  }

  /** `git diff` of the PR as GitHub shows it: from the merge base of base and head to head. */
  async diffText(repo: string, baseSha: string, headSha: string): Promise<string> {
    checkSha(baseSha);
    checkSha(headSha);
    const result = await this.git(
      this.barePath(repo),
      'diff',
      ...PLAIN_DIFF,
      '-M',
      `${baseSha}...${headSha}`,
    );
    return result.stdout;
  }

  /** The commit where `headSha` branched from `baseSha`: the old side of `diffText`. */
  async mergeBase(repo: string, baseSha: string, headSha: string): Promise<string> {
    checkSha(baseSha);
    checkSha(headSha);
    const result = await this.git(this.barePath(repo), 'merge-base', baseSha, headSha);
    return result.stdout.trim();
  }

  /** The content of `path` at `sha`, or `null` if the file does not exist there. */
  async fileAt(repo: string, sha: string, path: string): Promise<string | null> {
    checkSha(sha);
    const bare = this.barePath(repo);
    const result = await this.run('git', [...GIT_CONFIG, 'show', `${sha}:${path}`], { cwd: bare });
    if (result.code === 0) return result.stdout;
    // A missing path is an answer; a missing commit (or anything else) is an error.
    if (await this.has(bare, `${sha}^{commit}`)) return null;
    throw new CommandError('git', ['show', `${sha}:${path}`], result);
  }

  /** Run `task` after every earlier task for the same key has settled. */
  private locked<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    // The earlier task's caller gets its error; here it only means "that one is done".
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(key, next);
    void next
      .catch(() => undefined)
      .then(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    return next;
  }

  private barePath(repo: string): string {
    return join(this.home, 'repos', `${slug(repo)}.git`);
  }

  private async has(bare: string, object: string): Promise<boolean> {
    const result = await this.run('git', [...GIT_CONFIG, 'cat-file', '-e', object], { cwd: bare });
    return result.code === 0;
  }

  private git(cwd: string | undefined, ...args: string[]) {
    return runOk(this.run, 'git', [...GIT_CONFIG, ...args], { cwd });
  }
}

/**
 * `owner/name` -> `owner__name`, lowercased because GitHub repo names ignore case,
 * after checking it cannot escape the data dir.
 */
function slug(repo: string): string {
  if (!REPO.test(repo) || repo.split('/').some((part) => /^\.+$/.test(part))) {
    throw new Error(`Not an owner/name repo: ${repo}`);
  }
  return repo.toLowerCase().replace('/', '__');
}

function checkSha(sha: string): void {
  if (!SHA.test(sha)) throw new Error(`Not a full commit sha: ${sha}`);
}
