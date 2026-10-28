import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDiff } from '../../src/server/diff.js';
import { CommandError, realRunner, type Runner } from '../../src/server/exec.js';
import { RepoManager } from '../../src/server/repo.js';

const REPO = 'acme/widget';

let tmp: string;
let remote: string;
let home: string;
let base: string;
let head: string;

/** Run git in the fake remote with a fixed identity and no signing, whatever the user's config says. */
function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: remote, encoding: 'utf8' },
  ).trim();
}

function commit(files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(remote, path), text);
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/**
 * The fake GitHub remote: `main` with one commit, a PR branched from it that is only
 * reachable through `refs/pull/7/head`, and a later commit on `main` after the PR branched.
 */
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pr-tour-repo-'));
  remote = join(tmp, 'remote');
  home = join(tmp, 'home');
  execFileSync('git', ['init', '-q', '-b', 'main', remote]);
  base = commit({ 'greet.txt': 'hello\n', 'base.txt': 'one\n' }, 'base');
  git('checkout', '-q', '-b', 'pr');
  head = commit({ 'greet.txt': 'hello\nworld\n', 'ünïcode.txt': 'new\n' }, 'pr');
  git('update-ref', 'refs/pull/7/head', head);
  git('checkout', '-q', 'main');
  git('branch', '-q', '-D', 'pr');
  commit({ 'base.txt': 'one\ntwo\n' }, 'main moves on');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function recordingRunner(): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    return realRunner(cmd, args, opts);
  };
  return { run, calls };
}

function manager(run: Runner = realRunner): RepoManager {
  return new RepoManager(home, run, () => remote);
}

function gitSubcommands(calls: string[][]): string[] {
  // The subcommand is the first argument that is not an option or an option's value.
  return calls.map((c) => {
    const args = c.slice(1);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '-C') i++;
      else return args[i] ?? '';
    }
    return '';
  });
}

describe('RepoManager', () => {
  it('ensureWorktree clones, fetches and checks out head', async () => {
    const path = await manager().ensureWorktree(REPO, 7, base, head);
    expect(path).toBe(join(home, 'worktrees', 'acme__widget', head));
    expect(readFileSync(join(path, 'greet.txt'), 'utf8')).toBe('hello\nworld\n');
    expect(existsSync(join(home, 'repos', 'acme__widget.git'))).toBe(true);
  });

  it('ensureWorktree reuses an existing worktree', async () => {
    await manager().ensureWorktree(REPO, 7, base, head);
    const { run, calls } = recordingRunner();
    const path = await manager(run).ensureWorktree(REPO, 7, base, head);
    expect(readFileSync(join(path, 'greet.txt'), 'utf8')).toBe('hello\nworld\n');
    const subcommands = gitSubcommands(calls);
    expect(subcommands).not.toContain('clone');
    expect(subcommands).not.toContain('fetch');
    expect(subcommands).not.toContain('worktree');
  });

  it('ensureWorktree fetches a new head into the existing clone', async () => {
    await manager().ensureWorktree(REPO, 7, base, head);
    git('checkout', '-q', '--detach', head);
    const newHead = commit({ 'greet.txt': 'hello\nworld\nagain\n' }, 'pr update');
    git('update-ref', 'refs/pull/7/head', newHead);

    const { run, calls } = recordingRunner();
    const path = await manager(run).ensureWorktree(REPO, 7, base, newHead);
    expect(path).toBe(join(home, 'worktrees', 'acme__widget', newHead));
    expect(readFileSync(join(path, 'greet.txt'), 'utf8')).toBe('hello\nworld\nagain\n');
    expect(gitSubcommands(calls)).not.toContain('clone');
  });

  it('ensureWorktree remakes a worktree directory left over from an interrupted add', async () => {
    const path = join(home, 'worktrees', 'acme__widget', head);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'greet.txt'), 'half written');
    await manager().ensureWorktree(REPO, 7, base, head);
    expect(readFileSync(join(path, 'greet.txt'), 'utf8')).toBe('hello\nworld\n');
  });

  it('ensureWorktree checks out two PRs of one repo at the same time', async () => {
    git('checkout', '-q', '--detach', base);
    const head8 = commit({ 'other.txt': 'pr 8\n' }, 'pr 8');
    git('update-ref', 'refs/pull/8/head', head8);
    git('checkout', '-q', 'main');

    const m = manager();
    const [path7, path8] = await Promise.all([
      m.ensureWorktree(REPO, 7, base, head),
      m.ensureWorktree(REPO, 8, base, head8),
    ]);
    expect(readFileSync(join(path7, 'greet.txt'), 'utf8')).toBe('hello\nworld\n');
    expect(readFileSync(join(path8, 'other.txt'), 'utf8')).toBe('pr 8\n');
  });

  it('base and head survive git gc after their branches and worktree are gone', async () => {
    const m = manager();
    const mainTip = git('rev-parse', 'main');
    const path = await m.ensureWorktree(REPO, 7, mainTip, head);
    const clone = join(home, 'repos', 'acme__widget.git');
    const inClone = (...args: string[]) => execFileSync('git', args, { cwd: clone });
    inClone('worktree', 'remove', '--force', path);
    inClone('update-ref', '-d', 'refs/heads/main');
    inClone('update-ref', '-d', 'refs/pr/7');
    inClone('reflog', 'expire', '--expire=now', '--all');
    inClone('gc', '--quiet', '--prune=now');

    expect(await m.fileAt(REPO, mainTip, 'base.txt')).toBe('one\ntwo\n');
    expect(parseDiff(await m.diffText(REPO, mainTip, head)).map((f) => f.path)).toContain(
      'greet.txt',
    );
  });

  it('ensureWorktree throws CommandError when the clone fails', async () => {
    const broken = new RepoManager(home, realRunner, () => join(tmp, 'nowhere'));
    await expect(broken.ensureWorktree(REPO, 7, base, head)).rejects.toThrow(CommandError);
  });

  it('rejects a repo that is not owner/name and a sha that is not a full sha', async () => {
    const m = manager();
    await expect(m.ensureWorktree('../etc', 7, base, head)).rejects.toThrow(/owner\/name/);
    await expect(m.ensureWorktree(REPO, 7, base, '--upload-pack=x')).rejects.toThrow(/sha/);
  });

  it('diffText returns the merge-base diff', async () => {
    const m = manager();
    await m.ensureWorktree(REPO, 7, base, head);
    // The base the PR targets now is main's tip, which moved after the PR branched.
    const mainTip = git('rev-parse', 'main');
    const files = parseDiff(await m.diffText(REPO, mainTip, head));
    expect(files.map((f) => f.path).sort()).toEqual(['greet.txt', 'ünïcode.txt']);
    const greet = files.find((f) => f.path === 'greet.txt');
    expect(greet?.hunks[0]?.lines.filter((l) => l.kind === 'add')).toEqual([
      { kind: 'add', newNo: 2, text: 'world' },
    ]);
  });

  it('mergeBase is where the PR branched, after the base branch moved on', async () => {
    const m = manager();
    await m.ensureWorktree(REPO, 7, base, head);
    const mainTip = git('rev-parse', 'main');
    expect(mainTip).not.toBe(base);

    expect(await m.mergeBase(REPO, mainTip, head)).toBe(base);
  });

  it('mergeBase rejects a sha that is not a full sha', async () => {
    await expect(manager().mergeBase(REPO, '--all', head)).rejects.toThrow(/sha/);
  });

  it('repo names that differ only in case share one clone and worktree', async () => {
    const { run, calls } = recordingRunner();
    const m = manager(run);
    const first = await m.ensureWorktree('acme/widget', 7, base, head);
    calls.length = 0;

    const second = await m.ensureWorktree('Acme/Widget', 7, base, head);

    expect(second).toBe(first);
    expect(gitSubcommands(calls)).not.toContain('clone');
  });

  it('diffText and fileAt ignore diff tools, textconv and output options in git config', async () => {
    const m = manager();
    await m.ensureWorktree(REPO, 7, base, head);
    const script = join(tmp, 'junk-diff.sh');
    writeFileSync(script, '#!/bin/sh\necho junk\n');
    chmodSync(script, 0o755);
    const clone = join(home, 'repos', 'acme__widget.git');
    execFileSync('git', ['config', 'diff.external', script], { cwd: clone });
    execFileSync('git', ['config', 'color.diff', 'always'], { cwd: clone });
    execFileSync('git', ['config', 'diff.noprefix', 'true'], { cwd: clone });
    const attributes = join(tmp, 'attributes');
    writeFileSync(attributes, '*.txt diff=junk\n');
    execFileSync('git', ['config', 'core.attributesFile', attributes], { cwd: clone });
    execFileSync('git', ['config', 'diff.junk.textconv', script], { cwd: clone });

    const text = await m.diffText(REPO, base, head);
    expect(text).not.toContain('junk');
    expect(text).toContain('diff --git a/greet.txt b/greet.txt');
    expect(parseDiff(text).map((f) => f.path)).toContain('greet.txt');
    expect(await m.fileAt(REPO, head, 'greet.txt')).toBe('hello\nworld\n');
  });

  it('fileAt returns the content of a path at a sha', async () => {
    const m = manager();
    await m.ensureWorktree(REPO, 7, base, head);
    expect(await m.fileAt(REPO, base, 'greet.txt')).toBe('hello\n');
    expect(await m.fileAt(REPO, head, 'greet.txt')).toBe('hello\nworld\n');
  });

  it('fileAt returns null for a missing path', async () => {
    const m = manager();
    await m.ensureWorktree(REPO, 7, base, head);
    expect(await m.fileAt(REPO, base, 'ünïcode.txt')).toBeNull();
  });

  it('fileAt throws CommandError for an unknown commit', async () => {
    const m = manager();
    await m.ensureWorktree(REPO, 7, base, head);
    await expect(m.fileAt(REPO, 'f'.repeat(40), 'greet.txt')).rejects.toThrow(CommandError);
  });
});
