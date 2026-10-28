import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureServer,
  importReport,
  listen,
  parseArgs,
  readConfig,
  serverStatus,
  UsageError,
} from '../src/cli.js';
import { tourRules } from '../src/server/prompt.js';
import type { Tour } from '../src/shared/tour.js';

describe('parseArgs', () => {
  it('no args → serve', () => {
    expect(parseArgs([])).toEqual({ cmd: 'serve' });
  });

  it('import parses repo, pr, file', () => {
    expect(
      parseArgs(['import', '--repo', 'acme/api', '--pr', '12', '--file', 'tour.json']),
    ).toEqual({ cmd: 'import', repo: 'acme/api', pr: 12, file: 'tour.json' });
  });

  it('import without --file throws a usage error', () => {
    expect(() => parseArgs(['import', '--repo', 'acme/api', '--pr', '12'])).toThrow(UsageError);
  });

  it('import with a pr that is not a positive number throws a usage error', () => {
    expect(() =>
      parseArgs(['import', '--repo', 'acme/api', '--pr', '0', '--file', 'tour.json']),
    ).toThrow(UsageError);
  });

  it('open parses owner/name#12', () => {
    expect(parseArgs(['open', 'acme/api#12'])).toEqual({ cmd: 'open', repo: 'acme/api', pr: 12 });
  });

  it('open with a bad ref throws', () => {
    expect(() => parseArgs(['open', 'acme/api'])).toThrow(UsageError);
    expect(() => parseArgs(['open', 'acme#12'])).toThrow(UsageError);
    expect(() => parseArgs(['open', '../x#12'])).toThrow(UsageError);
  });

  it('schema and rules take no arguments', () => {
    expect(parseArgs(['schema'])).toEqual({ cmd: 'schema' });
    expect(parseArgs(['rules'])).toEqual({ cmd: 'rules' });
    expect(() => parseArgs(['schema', 'x'])).toThrow(UsageError);
    expect(() => parseArgs(['rules', '--pr', '1'])).toThrow(UsageError);
  });

  it('an unknown command or option throws a usage error', () => {
    expect(() => parseArgs(['build'])).toThrow(UsageError);
    expect(() => parseArgs(['--verbose'])).toThrow(UsageError);
  });
});

describe('readConfig', () => {
  it('defaults to port 4317 and ~/.pr-tour', () => {
    expect(readConfig({}, '/home/u')).toEqual({
      port: 4317,
      home: '/home/u/.pr-tour',
      openBrowser: true,
    });
  });

  it('reads PR_TOUR_PORT, PR_TOUR_HOME and PR_TOUR_NO_OPEN', () => {
    const env = { PR_TOUR_PORT: '5000', PR_TOUR_HOME: '/data/tours', PR_TOUR_NO_OPEN: '1' };
    expect(readConfig(env, '/home/u')).toEqual({
      port: 5000,
      home: '/data/tours',
      openBrowser: false,
    });
  });

  it('a relative PR_TOUR_HOME is made absolute from the working directory', () => {
    expect(readConfig({ PR_TOUR_HOME: 'tours' }, '/home/u', '/work').home).toBe('/work/tours');
  });

  it('a PR_TOUR_PORT that is not a port throws a usage error', () => {
    expect(() => readConfig({ PR_TOUR_PORT: 'abc' }, '/home/u')).toThrow(UsageError);
    expect(() => readConfig({ PR_TOUR_PORT: '70000' }, '/home/u')).toThrow(UsageError);
  });
});

describe('listen and serverStatus', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise((resolve) => s.close(() => resolve(null)))),
    );
  });

  async function healthyApp(): Promise<number> {
    const app = new Hono().get('/api/health', (c) => c.json({ ok: true }));
    const server = await listen(app, 0);
    servers.push(server);
    return (server.address() as AddressInfo).port;
  }

  it('listen binds to 127.0.0.1 only', async () => {
    const app = new Hono();
    const server = await listen(app, 0);
    servers.push(server);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('a pr-tour server answering /api/health is "pr-tour"', async () => {
    expect(await serverStatus(await healthyApp())).toBe('pr-tour');
  });

  it('a port nothing listens on is "free"', async () => {
    const port = await healthyApp();
    await new Promise((resolve) => servers.pop()?.close(resolve));
    expect(await serverStatus(port)).toBe('free');
  });

  it('a port taken by another server is "other"', async () => {
    const other = createServer((_req, res) => res.writeHead(404).end('nope'));
    servers.push(other);
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    expect(await serverStatus((other.address() as AddressInfo).port)).toBe('other');
  });

  it('listen on a taken port rejects', async () => {
    const port = await healthyApp();
    await expect(listen(new Hono(), port)).rejects.toThrow();
  });
});

describe('ensureServer', () => {
  /** A status check that answers `answers` in turn, then the last one forever. */
  const statuses = (...answers: ('pr-tour' | 'free' | 'other')[]) =>
    vi.fn(() => Promise.resolve(answers.length > 1 ? answers.shift()! : answers[0]!));
  const base = { port: 4317, log: '/data/server.log', waitMs: 200, pollMs: 5 };

  it('uses a pr-tour server that already runs and starts none', async () => {
    const start = vi.fn();
    expect(await ensureServer({ ...base, start, status: statuses('pr-tour') })).toBe('running');
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses a port taken by something else and starts none', async () => {
    const start = vi.fn();
    await expect(ensureServer({ ...base, start, status: statuses('other') })).rejects.toThrow(
      /Port 4317 is in use by something that is not pr-tour/,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('on a free port starts a server once and waits until it answers', async () => {
    const start = vi.fn();
    const status = statuses('free', 'free', 'free', 'pr-tour');
    expect(await ensureServer({ ...base, start, status })).toBe('started');
    expect(start).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(4);
  });

  it('a started server that never answers fails with the log path', async () => {
    await expect(
      ensureServer({ ...base, start: vi.fn(), status: statuses('free') }),
    ).rejects.toThrow(/did not start.*\/data\/server\.log/);
  });
});

describe('pr-tour open', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  let home: string;
  const pids: number[] = [];

  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** A port nothing listens on right now. */
  async function freePort(): Promise<number> {
    const server = await listen(new Hono(), 0);
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  it('starts a server in the background when none runs, then exits', async () => {
    home = mkdtempSync(join(tmpdir(), 'pr-tour-open-'));
    const port = await freePort();
    const env = { ...process.env, PR_TOUR_PORT: String(port), PR_TOUR_HOME: home };
    const open = () =>
      execFileSync(process.execPath, ['--import', 'tsx', cli, 'open', 'acme/api#12'], {
        env: { ...env, PR_TOUR_NO_OPEN: '1' },
        encoding: 'utf8',
        timeout: 20_000,
      });

    // execFileSync returns only once `open` exits and nothing holds its output open.
    const first = open();
    const pid = Number(/pid (\d+)/.exec(first)?.[1]);
    pids.push(pid);

    expect(first).toContain(`http://127.0.0.1:${port}/pr/acme/api/12`);
    expect(await serverStatus(port)).toBe('pr-tour');
    expect(existsSync(join(home, 'server.log'))).toBe(true);

    const second = open();
    expect(second).toContain('already running');
    expect(second).not.toMatch(/pid \d+/);
  }, 30_000);
});

describe('pr-tour schema and rules', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (cmd: string) =>
    execFileSync(process.execPath, ['--import', 'tsx', cli, cmd], { encoding: 'utf8' });

  it('schema prints JSON with a flows property', () => {
    const schema = JSON.parse(run('schema')) as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('flows');
  });

  it('rules prints the same rules the build prompt embeds', () => {
    expect(run('rules')).toBe(`${tourRules()}\n`);
  });
});

describe('importReport', () => {
  const tour = {
    check: { problems: ['f1 home a.ts:1-3 covers no changed lines'] },
    other: [
      {
        kind: 'tests',
        title: 'Tests',
        summary: '',
        items: [{ id: 'o1.1', file: 't.ts', title: 'x', homes: [] }],
      },
      {
        kind: 'unexplained',
        title: 'Unexplained',
        summary: '',
        items: [
          { id: 'u1', file: 'b.ts', title: 'b.ts: added lines 4-5', homes: [] },
          { id: 'u2', file: 'c.ts', title: 'c.ts: deleted line 9', homes: [] },
        ],
      },
    ],
  } as unknown as Tour;

  it('lists every problem and every unexplained range, so the author can fix the homes', () => {
    expect(importReport(tour)).toEqual([
      'problem: f1 home a.ts:1-3 covers no changed lines',
      'unexplained: b.ts: added lines 4-5',
      'unexplained: c.ts: deleted line 9',
    ]);
  });

  it('is empty for a tour where every changed line has one home', () => {
    expect(importReport({ check: { problems: [] }, other: [] } as unknown as Tour)).toEqual([]);
  });
});
