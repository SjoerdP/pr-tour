// Builds the Go checker into dist/bin/pr-tour-check-go (or --out <path>).
// The checker is optional: without Go 1.26+ this prints one line and exits 0.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import console from 'node:console';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const out =
  outIdx >= 0 && argv[outIdx + 1]
    ? resolve(argv[outIdx + 1])
    : resolve(root, 'dist/bin/pr-tour-check-go');
const env = { ...process.env, GOTOOLCHAIN: 'local' };

const skip = (why) => {
  console.log(`${why}: building without the Go checker`);
  process.exit(0);
};

const ver = spawnSync('go', ['env', 'GOVERSION'], { env, encoding: 'utf8' });
if (ver.error || ver.status !== 0) skip('go not found');
const m = /^go(\d+)\.(\d+)/.exec(ver.stdout.trim());
if (!m) skip(`go version "${ver.stdout.trim()}" not understood`);
const [major, minor] = [Number(m[1]), Number(m[2])];
if (major < 1 || (major === 1 && minor < 26)) skip(`go ${major}.${minor} is older than 1.26`);

mkdirSync(dirname(out), { recursive: true });
const build = spawnSync('go', ['build', '-o', out, '.'], {
  cwd: resolve(root, 'checker/go'),
  env,
  stdio: 'inherit',
});
if (build.status !== 0) {
  console.error('go build of the checker failed');
  process.exit(build.status ?? 1);
}
console.log(`built ${out}`);
