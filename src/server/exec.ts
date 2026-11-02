import { execFile } from 'node:child_process';

export type RunOptions = {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  /** Stop the command when it prints nothing, on stdout or stderr, for this long. */
  idleTimeoutMs?: number;
  /** Called with each line of stdout as it arrives, without the newline. */
  onLine?: (line: string) => void;
  /** Extra environment variables, merged over the process environment. */
  env?: Record<string, string>;
};
export type RunResult = { stdout: string; stderr: string; code: number };

/** The one way out of the process: run an external command (gh, git, claude). */
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Longest stderr line kept in `CommandError.shortMessage`. */
const SHORT_LINE_CHARS = 200;

/**
 * A command exited non-zero where the caller needed it to succeed. `message` has the
 * full command line and stderr, for the log; `shortMessage` is fit to show the user.
 */
export class CommandError extends Error {
  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly result: RunResult,
  ) {
    super(`${[cmd, ...args].join(' ')} exited with code ${result.code}: ${result.stderr.trim()}`);
    this.name = 'CommandError';
  }

  /** `<cmd> failed: <first stderr line>`, without the arguments (they can hold a whole query). */
  get shortMessage(): string {
    const line = firstLine(this.result.stderr);
    if (line === undefined) return `${this.cmd} failed with exit code ${this.result.code}`;
    return `${this.cmd} failed: ${line}`;
  }
}

/** The first non-empty line of `text`, trimmed and cut to a length fit for a message. */
export function firstLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return undefined;
  return line.length > SHORT_LINE_CHARS ? `${line.slice(0, SHORT_LINE_CHARS)}...` : line;
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

/** How long a stopped command gets to exit before it is killed outright. */
const KILL_GRACE_MS = 5000;

/**
 * `execFile` behind the `Runner` type. Never throws: a non-zero exit returns its code.
 * When the command does not exit normally (not found, over `timeoutMs`, silent for
 * `idleTimeoutMs`, output over `maxBuffer`) the code is non-zero and the reason is the first
 * line of stderr, so `CommandError.shortMessage` and other first-line messages show it.
 * A command stopped by either limit that ignores the signal is killed after `KILL_GRACE_MS`.
 */
export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    /** Why pr-tour stopped the command; the first limit to hit wins. */
    let stopped: string | undefined;
    let idle: NodeJS.Timeout | undefined;
    let total: NodeJS.Timeout | undefined;
    let kill: NodeJS.Timeout | undefined;
    const stop = (reason: string) => {
      if (stopped !== undefined) return;
      stopped = reason;
      clearTimeout(idle);
      clearTimeout(total);
      child.kill();
      kill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    const waitForOutput = () => {
      const ms = opts.idleTimeoutMs;
      if (ms === undefined || stopped !== undefined) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop(`${cmd} printed nothing for ${ms / 1000} s`), ms);
    };
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        env: opts.env ? { ...ENV, ...opts.env } : ENV,
      },
      (error, stdout, stderr) => {
        clearTimeout(idle);
        clearTimeout(total);
        clearTimeout(kill);
        if (!error) return resolve({ stdout, stderr, code: 0 });
        if (stopped !== undefined) {
          return resolve({ stdout, stderr: `${stopped}\n${stderr}`, code: 1 });
        }
        const code = error.code;
        if (typeof code === 'number') return resolve({ stdout, stderr, code });
        const reason = code === 'ENOENT' ? `${cmd} not found` : error.message;
        resolve({ stdout, stderr: `${reason}\n${stderr}`, code: 1 });
      },
    );
    const ms = opts.timeoutMs;
    if (ms !== undefined) {
      total = setTimeout(() => stop(`${cmd} timed out after ${ms / 1000} s`), ms);
    }
    waitForOutput();
    child.stderr?.on('data', waitForOutput);
    let partial = '';
    child.stdout?.on('data', (chunk: string) => {
      waitForOutput();
      if (!opts.onLine) return;
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) opts.onLine(line);
    });
    child.stdout?.on('end', () => {
      if (partial !== '') opts.onLine?.(partial);
    });
    // A command that exits before reading all input closes stdin early; that is not our error.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input);
  });
