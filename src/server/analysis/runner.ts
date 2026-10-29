import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { firstLine, type Runner } from '../exec.js';
import {
  CHECKER_VERSION,
  type CheckInput,
  type CheckOutput,
  type FunctionsInput,
  type FunctionsOutput,
} from './contract.js';

export type CheckerResult<T> =
  { ok: true; output: T; ms: number } | { ok: false; problem: string; ms: number };

export type RunnerOptions = { timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 30_000;

/** Keep the Go toolchain offline and read-only, whatever the checker does itself. */
const CHECKER_ENV = { GOPROXY: 'off', GOFLAGS: '-mod=readonly', GOTOOLCHAIN: 'local' };

/** The nearest directory above this module that holds a package.json (works from src/ and dist/). */
function packageRoot(): string | null {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `PR_TOUR_CHECKER`, else `<package root>/dist/bin/pr-tour-check-go`; null unless executable. */
export function checkerPath(): string | null {
  const override = process.env.PR_TOUR_CHECKER;
  let path: string | null;
  if (override) path = override;
  else {
    const root = packageRoot();
    path = root === null ? null : join(root, 'dist', 'bin', 'pr-tour-check-go');
  }
  return path !== null && isExecutable(path) ? path : null;
}

async function invoke<T extends { version: number }>(
  run: Runner,
  args: string[],
  root: string,
  input: unknown,
  timeoutMs: number,
): Promise<CheckerResult<T>> {
  const start = Date.now();
  const fail = (problem: string): CheckerResult<T> => ({
    ok: false,
    problem,
    ms: Date.now() - start,
  });
  const bin = checkerPath();
  if (bin === null) return fail('the Go checker is not installed');
  const result = await run(bin, [...args, '--root', root], {
    input: JSON.stringify(input),
    timeoutMs,
    env: CHECKER_ENV,
  });
  if (result.code !== 0) {
    return fail(firstLine(result.stderr) ?? `exit code ${result.code}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return fail('the checker printed invalid JSON');
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  if (version !== CHECKER_VERSION) {
    return fail(`the checker speaks version ${String(version)}, expected ${CHECKER_VERSION}`);
  }
  return { ok: true, output: parsed as T, ms: Date.now() - start };
}

/** Functions that contain changed lines. */
export function runFunctions(
  run: Runner,
  root: string,
  input: FunctionsInput,
  opts: RunnerOptions = {},
): Promise<CheckerResult<FunctionsOutput>> {
  return invoke<FunctionsOutput>(
    run,
    ['functions'],
    root,
    input,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

/** Check the tour against the code: typed first, then once more syntax-only. */
export async function runCheck(
  run: Runner,
  root: string,
  input: CheckInput,
  opts: RunnerOptions = {},
): Promise<CheckerResult<CheckOutput>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const typed = await invoke<CheckOutput>(run, ['check'], root, input, timeoutMs);
  if (typed.ok) return typed;
  const syntax = await invoke<CheckOutput>(run, ['check', '--syntax-only'], root, input, timeoutMs);
  if (syntax.ok) return { ...syntax, ms: typed.ms + syntax.ms };
  return {
    ok: false,
    problem: `Go check failed: ${typed.problem}; syntax-only check failed: ${syntax.problem}`,
    ms: typed.ms + syntax.ms,
  };
}
