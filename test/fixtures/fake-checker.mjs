#!/usr/bin/env node
// Stand-in for pr-tour-check-go in tests. FAKE_CHECKER_MODE picks the behaviour.
// Only the typed `check` run is affected by failure modes; `--syntax-only` answers
// unless the mode is `both-fail`.
import { readFileSync } from 'node:fs';

const mode = process.env.FAKE_CHECKER_MODE ?? 'ok';
const args = process.argv.slice(2);
const syntaxOnly = args.includes('--syntax-only');
const out = (v) => process.stdout.write(JSON.stringify(v));
const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(3);
};

readFileSync(0, 'utf8');

if (args[0] === 'functions') {
  if (mode === 'both-fail') fail('fake: cannot load project');
  out({
    version: mode === 'old-version' ? 0 : 1,
    functions: [{ file: 'a.go', name: 'Foo', startLine: 1, endLine: 5 }],
  });
} else {
  const output = (engine) => ({
    version: 1,
    engine,
    engineVersion: 'fake',
    degraded: engine === 'go-syntax',
    steps: {},
    links: {},
    problems: [],
  });
  if (syntaxOnly) {
    if (mode === 'both-fail') fail('fake: syntax parse failed');
    out(output('go-syntax'));
  } else if (mode === 'typed-fails' || mode === 'both-fail') {
    fail('fake: cannot load project');
  } else if (mode === 'hang') {
    setTimeout(() => undefined, 60_000);
  } else if (mode === 'bad-json') {
    process.stdout.write('not json');
  } else if (mode === 'old-version') {
    out({ ...output('go-types'), version: 0 });
  } else {
    out(output('go-types'));
  }
}
