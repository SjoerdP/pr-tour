import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { firstLine, type Runner } from '../exec.js';
import type { z } from 'zod';
import {
  CHECKER_VERSION,
  CheckOutputSchema,
  FunctionsOutputSchema,
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

const NOT_INSTALLED = 'the Go checker is not installed';

async function invoke<T>(
  run: Runner,
  schema: z.ZodType<T>,
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
  if (bin === null) return fail(NOT_INSTALLED);
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
  // A tour that holds bad checker output saves but never loads: check it here, so a bad answer
  // is a failure like invalid JSON and the fallback chain handles it.
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown';
    return fail(`the checker printed output that breaks the contract (${where})`);
  }
  return { ok: true, output: checked.data, ms: Date.now() - start };
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
    FunctionsOutputSchema,
    ['functions'],
    root,
    input,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

/**
 * Check the tour against the code: typed first, then once more syntax-only. A syntax-only
 * result after a failed typed run is degraded and says why the typed run failed.
 */
export async function runCheck(
  run: Runner,
  root: string,
  input: CheckInput,
  opts: RunnerOptions = {},
): Promise<CheckerResult<CheckOutput>> {
  if (checkerPath() === null) return { ok: false, problem: NOT_INSTALLED, ms: 0 };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const check = (args: string[]) =>
    invoke<CheckOutput>(run, CheckOutputSchema, args, root, input, timeoutMs);
  const typed = await check(['check']);
  if (typed.ok) return typed;
  const syntax = await check(['check', '--syntax-only']);
  if (syntax.ok) {
    const output: CheckOutput = {
      ...syntax.output,
      degraded: true,
      problems: [`typed check failed: ${typed.problem}`, ...syntax.output.problems],
    };
    return { ok: true, output, ms: typed.ms + syntax.ms };
  }
  return {
    ok: false,
    problem: `Go check failed: ${typed.problem}; syntax-only check failed: ${syntax.problem}`,
    ms: typed.ms + syntax.ms,
  };
}
