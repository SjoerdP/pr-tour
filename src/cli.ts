#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { createApp } from './server/app.js';
import { TourBuilder, TourBuildError } from './server/build.js';
import { CommandError, realRunner } from './server/exec.js';
import { GitHub, InvalidRepoError, PrNotFoundError } from './server/github.js';
import { Jobs } from './server/jobs.js';
import { RepoManager } from './server/repo.js';
import { Store } from './server/store.js';

export const USAGE = `Usage:
  pr-tour                                                   start pr-tour and open it in the browser
  pr-tour open <owner/name>#<pr>                            open the tour of a PR
  pr-tour import --repo <owner/name> --pr <n> --file <path> store a tour written by the PR's author

Environment:
  PR_TOUR_PORT     port to listen on (default 4317)
  PR_TOUR_HOME     data dir (default ~/.pr-tour)
  PR_TOUR_NO_OPEN  set to 1 to not open the browser`;

/** The command line is wrong; the message says how, and the usage text follows it. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Command =
  | { cmd: 'serve' }
  | { cmd: 'import'; repo: string; pr: number; file: string }
  | { cmd: 'open'; repo: string; pr: number };

/** The only address the server listens on: this machine, never the network. */
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4317;
const HEALTH_TIMEOUT_MS = 1000;

/** `owner/name`, with the characters GitHub allows and no `.`/`..` parts. */
const REPO_RE = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;
const PR_RE = /^[1-9]\d{0,9}$/;

function parseRepo(repo: string | undefined): string {
  if (repo === undefined) throw new UsageError('Missing --repo <owner/name>.');
  if (!REPO_RE.test(repo)) throw new UsageError(`Not a repo: ${repo} (expected owner/name).`);
  return repo;
}

function parsePr(pr: string | undefined): number {
  if (pr === undefined) throw new UsageError('Missing --pr <number>.');
  if (!PR_RE.test(pr)) throw new UsageError(`Not a PR number: ${pr}`);
  return Number(pr);
}

/** Parse the arguments after `pr-tour`; throws `UsageError` on anything it does not know. */
export function parseArgs(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: 'string' },
        pr: { type: 'string' },
        file: { type: 'string' },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  const [cmd, ...rest] = positionals;
  const hasOptions = Object.keys(values).length > 0;

  if (cmd === undefined) {
    if (hasOptions) throw new UsageError('Options need a command.');
    return { cmd: 'serve' };
  }
  if (cmd === 'import') {
    if (rest.length > 0) throw new UsageError(`Unexpected argument: ${rest[0]}`);
    const repo = parseRepo(values.repo);
    const pr = parsePr(values.pr);
    if (values.file === undefined) throw new UsageError('Missing --file <path>.');
    return { cmd: 'import', repo, pr, file: values.file };
  }
  if (cmd === 'open') {
    if (hasOptions || rest.length !== 1) throw new UsageError('open takes one <owner/name>#<pr>.');
    const ref = rest[0] ?? '';
    const hash = ref.lastIndexOf('#');
    if (hash < 0) throw new UsageError(`Not a PR: ${ref} (expected owner/name#<pr>).`);
    return { cmd: 'open', repo: parseRepo(ref.slice(0, hash)), pr: parsePr(ref.slice(hash + 1)) };
  }
  throw new UsageError(`Unknown command: ${cmd}`);
}

export type Config = { port: number; home: string; openBrowser: boolean };

/** Settings from `PR_TOUR_*` environment variables. */
export function readConfig(env: NodeJS.ProcessEnv, userHome: string): Config {
  const portText = env.PR_TOUR_PORT ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new UsageError(`PR_TOUR_PORT is not a port: ${portText}`);
  }
  return {
    port,
    home: env.PR_TOUR_HOME || join(userHome, '.pr-tour'),
    openBrowser: env.PR_TOUR_NO_OPEN !== '1',
  };
}

/** Serve `app` on 127.0.0.1:`port` (0 picks a free port); rejects if the port is taken. */
export function listen(app: Pick<Hono, 'fetch'>, port: number): Promise<ServerType> {
  const server = createAdaptorServer({ fetch: app.fetch });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: HOST, port }, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** Who answers on 127.0.0.1:`port`: a pr-tour server, nobody, or something else. */
export async function serverStatus(port: number): Promise<'pr-tour' | 'free' | 'other'> {
  let res: Response;
  try {
    res = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (err) {
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    // Refused: nothing listens. Anything else (a timeout, a non-HTTP answer) means the port is taken.
    return code === 'ECONNREFUSED' ? 'free' : 'other';
  }
  try {
    const body = (await res.json()) as { ok?: unknown };
    return res.ok && body.ok === true ? 'pr-tour' : 'other';
  } catch {
    // Not JSON: some other server.
    return 'other';
  }
}

function tourUrl(port: number, repo: string, pr: number): string {
  return `http://${HOST}:${port}/pr/${repo}/${pr}`;
}

/** Open `url` in the user's browser; if that fails, the user still has the printed URL. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(`Could not open a browser; open ${url} yourself.`));
  child.unref();
}

/** The real dependencies, all rooted in the data dir. */
function wire(home: string) {
  mkdirSync(home, { recursive: true });
  const repos = new RepoManager(home, realRunner);
  const github = new GitHub(realRunner);
  const store = new Store(join(home, 'pr-tour.db'));
  const builder = new TourBuilder({ run: realRunner, repos, github, store, home });
  return { repos, github, store, builder, jobs: new Jobs() };
}

/** `pr-tour` and `pr-tour open`: make sure a server runs, then show `url`. */
async function serve(config: Config, url: string): Promise<void> {
  const status = await serverStatus(config.port);
  if (status === 'other') {
    throw new Error(
      `Port ${config.port} is in use by something that is not pr-tour. Set PR_TOUR_PORT to another port.`,
    );
  }
  if (status === 'free') {
    const deps = wire(config.home);
    let server: ServerType;
    try {
      server = await listen(createApp({ ...deps, port: config.port }), config.port);
    } catch (err) {
      deps.store.close();
      throw err;
    }
    const shutdown = () => {
      server.close();
      deps.store.close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    console.log(`pr-tour is running at http://${HOST}:${config.port}`);
  } else {
    console.log(`pr-tour is already running at http://${HOST}:${config.port}`);
  }
  if (config.openBrowser) {
    console.log(`Opening ${url}`);
    openBrowser(url);
  }
}

/** `pr-tour import`: check and store an author-made tour. */
async function importTour(config: Config, repo: string, pr: number, file: string): Promise<void> {
  let bodyJson: string;
  try {
    bodyJson = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`, {
      cause: err,
    });
  }
  const { store, builder } = wire(config.home);
  try {
    const tour = await builder.importAuthorTour(repo, pr, bodyJson);
    for (const problem of tour.check.problems) console.log(`problem: ${problem}`);
    console.log(tourUrl(config.port, repo, pr));
  } finally {
    store.close();
  }
}

/** A short message for an error at the CLI surface, without a stack. */
function errorMessage(err: unknown): string {
  // The details of an invalid tour file are the zod error: the author needs them to fix it.
  if (err instanceof TourBuildError) return `${err.message}\n${err.details}`;
  if (err instanceof CommandError) return err.shortMessage;
  if (err instanceof InvalidRepoError || err instanceof PrNotFoundError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function main(argv: string[]): Promise<void> {
  try {
    const command = parseArgs(argv);
    const config = readConfig(process.env, homedir());
    if (command.cmd === 'import') {
      await importTour(config, command.repo, command.pr, command.file);
    } else if (command.cmd === 'open') {
      await serve(config, tourUrl(config.port, command.repo, command.pr));
    } else {
      await serve(config, `http://${HOST}:${config.port}/`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
    } else {
      console.error(`pr-tour: ${errorMessage(err)}`);
    }
    process.exit(1);
  }
}

/** True when this file is the program being run (not imported by a test). */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // argv[1] is not a file (e.g. `node -e`); this file was imported.
    return false;
  }
}

if (isEntryPoint()) void main(process.argv.slice(2));
