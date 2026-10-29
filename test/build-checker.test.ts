import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
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

  it.skipIf(!hasGo)('with go: writes an executable binary to the --out path', () => {
    const out = join(tmp(), 'pr-tour-check-go');
    const r = spawnSync(process.execPath, [script, '--out', out], { encoding: 'utf8' });
    const text = r.stdout + r.stderr;
    if (text.includes('is older than 1.26')) return; // too old Go: nothing to build
    expect(r.status, text).toBe(0);
    expect(() => accessSync(out, constants.X_OK)).not.toThrow();
    const v = spawnSync(out, ['version'], { encoding: 'utf8' });
    expect(v.stdout.trim()).toBe('1');
  });
});
