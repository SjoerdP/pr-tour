import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/build-checker.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pr-tour-bc-'));
  dirs.push(d);
  return d;
};
const hasGo = spawnSync('go', ['version']).status === 0;

describe('build-checker script', () => {
  it('without go on the PATH: exits 0 and says it builds without the checker', () => {
    const r = spawnSync(process.execPath, [script], {
      env: { PATH: tmp() },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain('go not found: building without the Go checker');
  });

  it('with a go that fails: exits 0 and says go env failed, not "go not found"', () => {
    const bin = tmp();
    const go = join(bin, 'go');
    writeFileSync(go, '#!/bin/sh\necho "go: broken GOROOT" >&2\necho second line >&2\nexit 3\n');
    chmodSync(go, 0o755);
    const r = spawnSync(process.execPath, [script], { env: { PATH: bin }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const text = r.stdout + r.stderr;
    expect(text).toContain('go env failed: go: broken GOROOT: building without the Go checker');
    expect(text).not.toContain('go not found');
    expect(text).not.toContain('second line');
  });

  it('--out without a value: exits 2 with a short message', () => {
    for (const args of [['--out'], ['--out', '--verbose']]) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--out needs a path');
    }
  });

  // A cold build cache compiles the checker and golang.org/x/tools: far over the 5 s default.
  it.skipIf(!hasGo)(
    'with go: writes an executable binary to the --out path',
    (ctx) => {
      const out = join(tmp(), 'pr-tour-check-go');
      const r = spawnSync(process.execPath, [script, '--out', out], { encoding: 'utf8' });
      const text = r.stdout + r.stderr;
      if (text.includes('is older than 1.26')) {
        expect(r.status, text).toBe(0);
        ctx.skip('go is older than 1.26: nothing to build');
      }
      expect(r.status, text).toBe(0);
      expect(() => accessSync(out, constants.X_OK)).not.toThrow();
      const v = spawnSync(out, ['version'], { encoding: 'utf8' });
      expect(v.stdout.trim()).toBe('1');
    },
    120_000,
  );
});
