import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError, runOk, type Runner } from './exec.js';

const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Git options that keep the user's own git config from changing output we parse
 * or from running their hooks:
 * - `core.quotepath=off`: non-ASCII paths come out as-is instead of "\303\274"-quoted.
 * - `core.hooksPath=/dev/null`: `worktree add` does not run a global post-checkout hook.
 */
const GIT_CONFIG = ['-c', 'core.quotepath=off', '-c', 'core.hooksPath=/dev/null'];

/**
 * Plain unified diff whatever the config says: no external diff tool, no colour,
 * the standard a/ b/ prefixes (overrides diff.noprefix and diff.mnemonicPrefix),
 * and paths relative to the repo root (overrides diff.relative).
 */
const PLAIN_DIFF = [
  '--no-ext-diff',
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
    if (existsSync(path)) return path;

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
    // Forget worktrees whose directory was deleted, so `add` does not refuse the path.
    await this.git(bare, 'worktree', 'prune');
    await this.git(bare, 'worktree', 'add', '--quiet', '--detach', path, headSha);
    return path;
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

/** `owner/name` -> `owner__name`, after checking it cannot escape the data dir. */
function slug(repo: string): string {
  if (!REPO.test(repo) || repo.split('/').some((part) => /^\.+$/.test(part))) {
    throw new Error(`Not an owner/name repo: ${repo}`);
  }
  return repo.replace('/', '__');
}

function checkSha(sha: string): void {
  if (!SHA.test(sha)) throw new Error(`Not a full commit sha: ${sha}`);
}
