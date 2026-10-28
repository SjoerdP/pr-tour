import { execFile } from 'node:child_process';

export type RunOptions = { cwd?: string; input?: string; timeoutMs?: number };
export type RunResult = { stdout: string; stderr: string; code: number };

/** The one way out of the process: run an external command (gh, git, claude). */
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** A command exited non-zero where the caller needed it to succeed. */
export class CommandError extends Error {
  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly result: RunResult,
  ) {
    super(`${[cmd, ...args].join(' ')} exited with code ${result.code}: ${result.stderr.trim()}`);
    this.name = 'CommandError';
  }
}

/** Run a command and throw `CommandError` unless it exits 0. */
export async function runOk(
  run: Runner,
  cmd: string,
  args: string[],
  opts?: RunOptions,
): Promise<RunResult> {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) throw new CommandError(cmd, args, result);
  return result;
}

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Environment for every command. `GIT_TERMINAL_PROMPT=0` makes git fail instead of
 * waiting for a username/password on a terminal nobody is watching (the server runs
 * commands in the background); it has no effect on gh or claude.
 */
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

/**
 * `execFile` behind the `Runner` type. Never throws: a non-zero exit returns its code.
 * When the command does not exit normally (not found, killed by the timeout, output over
 * `maxBuffer`) the code is non-zero and the reason is appended to stderr.
 */
export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        env: ENV,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, code: 0 });
        const code = error.code;
        if (typeof code === 'number') return resolve({ stdout, stderr, code });
        resolve({ stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`, code: 1 });
      },
    );
    // A command that exits before reading all input closes stdin early; that is not our error.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input);
  });
