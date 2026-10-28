import type { RunOptions, RunResult, Runner } from '../../src/server/exec.js';

export type RunCall = { cmd: string; args: string[]; opts: RunOptions | undefined };

type Answer = RunResult | ((call: RunCall) => RunResult | Promise<RunResult>);

/**
 * A runner that answers from canned output and records every call it saw.
 * `answer` is either one result for every call or a function of the call.
 */
export function fakeRunner(answer: Answer): { run: Runner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: Runner = async (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    return typeof answer === 'function' ? answer(call) : answer;
  };
  return { run, calls };
}

/** A successful run that printed `stdout`. */
export function ok(stdout: string): RunResult {
  return { stdout, stderr: '', code: 0 };
}
