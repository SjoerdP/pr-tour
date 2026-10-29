import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realRunner, type Runner } from '../../src/server/exec.js';
import { checkerPath, runCheck, runFunctions } from '../../src/server/analysis/runner.js';

const fake = join(import.meta.dirname, '../fixtures/fake-checker.mjs');
const input = { flows: [] };
const withMode =
  (mode: string): Runner =>
  (cmd, args, opts) =>
    realRunner(cmd, args, { ...opts, env: { ...opts?.env, FAKE_CHECKER_MODE: mode } });

const saved = process.env.PR_TOUR_CHECKER;
afterEach(() => {
  if (saved === undefined) delete process.env.PR_TOUR_CHECKER;
  else process.env.PR_TOUR_CHECKER = saved;
});

describe('runCheck', () => {
  it('returns the typed output', async () => {
    process.env.PR_TOUR_CHECKER = fake;
    const r = await runCheck(withMode('ok'), '/tmp', input);
    expect(r.ok && r.output.engine).toBe('go-types');
  });

  it('falls back to syntax-only when typed fails', async () => {
    process.env.PR_TOUR_CHECKER = fake;
    const r = await runCheck(withMode('typed-fails'), '/tmp', input);
    expect(r.ok && r.output.engine).toBe('go-syntax');
  });

  it('names both failures when both fail', async () => {
    process.env.PR_TOUR_CHECKER = fake;
    const r = await runCheck(withMode('both-fail'), '/tmp', input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain('Go check failed: fake: cannot load project');
      expect(r.problem).toContain('syntax-only check failed: fake: syntax parse failed');
    }
  });

  it('kills a hanging typed run at the timeout and uses syntax-only', async () => {
    process.env.PR_TOUR_CHECKER = fake;
    // Long enough that a normal fake start is never cut, even when the suite is busy; the hang
    // mode sleeps for 60 s, so only the timeout can end the typed run.
    const r = await runCheck(withMode('hang'), '/tmp', input, { timeoutMs: 2500 });
    expect(r.ok && r.output.engine).toBe('go-syntax');
    expect(r.ok && r.output.degraded).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(2400);
    expect(r.ms).toBeLessThan(30_000);
  });

  it('treats invalid JSON as a failure', async () => {
    process.env.PR_TOUR_CHECKER = fake;
    const r = await runCheck(withMode('bad-json'), '/tmp', input);
    expect(r.ok && r.output.engine).toBe('go-syntax');
  });

  it('treats a wrong version as a failure', async () => {
    process.env.PR_TOUR_CHECKER = fake;
    const r = await runCheck(withMode('old-version'), '/tmp', input);
    expect(r.ok && r.output.engine).toBe('go-syntax');
  });

  it('reports a missing checker', async () => {
    process.env.PR_TOUR_CHECKER = '/nonexistent/pr-tour-check-go';
    const r = await runCheck(withMode('ok'), '/tmp', input);
    expect(r.ok).toBe(false);
  });
});

describe('runFunctions', () => {
  it('returns the functions', async () => {
    process.env.PR_TOUR_CHECKER = fake;
    const r = await runFunctions(withMode('ok'), '/tmp', { files: [] });
    expect(r.ok && r.output.functions[0]?.name).toBe('Foo');
  });

  it('rejects a wrong version', async () => {
    process.env.PR_TOUR_CHECKER = fake;
    const r = await runFunctions(withMode('old-version'), '/tmp', { files: [] });
    expect(r.ok).toBe(false);
  });
});

describe('checkerPath', () => {
  it('uses PR_TOUR_CHECKER when it is executable', () => {
    process.env.PR_TOUR_CHECKER = fake;
    expect(checkerPath()).toBe(fake);
  });

  it('returns null when the file is absent', () => {
    process.env.PR_TOUR_CHECKER = '/nonexistent/pr-tour-check-go';
    expect(checkerPath()).toBeNull();
  });

  it('returns null when the file is not executable', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'chk-')), 'x');
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    process.env.PR_TOUR_CHECKER = file;
    expect(checkerPath()).toBeNull();
  });

  it('returns null by default when the binary is not built', () => {
    delete process.env.PR_TOUR_CHECKER;
    const p = checkerPath();
    if (p !== null) expect(p).toMatch(/dist\/bin\/pr-tour-check-go$/);
  });
});
