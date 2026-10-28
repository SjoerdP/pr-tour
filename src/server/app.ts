import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { InboxResponse, PrResponse, PrSummary } from '../shared/api.js';
import { homeIds, type Tour } from '../shared/tour.js';
import { TourBuildError, type TourBuilder } from './build.js';
import { parseDiff } from './diff.js';
import { CommandError } from './exec.js';
import { InvalidRepoError, PrNotFoundError, type GitHub } from './github.js';
import type { Jobs } from './jobs.js';
import type { RepoManager } from './repo.js';
import { StoreError, type Store } from './store.js';

export type AppDeps = {
  github: Pick<GitHub, 'inbox' | 'pr'>;
  repos: Pick<RepoManager, 'fileAt' | 'diffText'>;
  store: Store;
  builder: Pick<TourBuilder, 'build'>;
  jobs: Jobs;
  /** The port the server listens on; the only one the `Host` header may name. */
  port: number;
  /** The built web app. Defaults to `dist/web`, next to this file's `dist/server`. */
  webDir?: string;
};

/** A request the API refuses, with the status to answer. The message is shown to the user. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** GitHub stores PR numbers as 32-bit signed ints. */
const MAX_PR = 2147483647;

const INTERNAL_ERROR = 'Internal error; see the pr-tour server log.';

/** An owner or repo name: what GitHub allows, and never `.` or `..`. */
const NamePartSchema = z
  .string()
  .regex(/^[\w.-]+$/)
  .refine((part) => !/^\.+$/.test(part));

const PrParamsSchema = z.object({
  owner: NamePartSchema,
  name: NamePartSchema,
  pr: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .refine((pr) => pr <= MAX_PR),
});

/** A path inside the repo: relative, no empty, `.` or `..` segments. */
const RepoPathSchema = z
  .string()
  .min(1)
  .refine((path) => path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'));

const FileQuerySchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  path: RepoPathSchema,
});

const DiffQuerySchema = z.object({ file: RepoPathSchema });

const SeenBodySchema = z.object({
  homeId: z.string().min(1).max(100),
  contentHash: z.string().regex(/^[0-9a-f]{40}$/),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, `Invalid ${what}`);
  return result.data;
}

/**
 * The `:owner/:name/:pr` params as `{ repo, pr, key }`; `key` names the PR's build job.
 * `repo` is lowercased: GitHub names ignore case, so `Acme/Greet` is the same PR and tour.
 */
function prParams(c: Context) {
  const { owner, name, pr } = parse(PrParamsSchema, c.req.param(), 'PR in the URL');
  const repo = `${owner}/${name}`.toLowerCase();
  return { repo, pr, key: `${repo}#${pr}` };
}

/** Full detail of an error, for the server log. */
function logDetail(err: unknown): string {
  if (err instanceof TourBuildError) return `${err.message}\n${err.details}`;
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

/** A short message for the user, or `null` for an error they cannot act on. */
function userMessage(err: unknown): string | null {
  if (err instanceof CommandError) return err.shortMessage;
  if (
    err instanceof HttpError ||
    err instanceof TourBuildError ||
    err instanceof PrNotFoundError ||
    err instanceof InvalidRepoError
  ) {
    return err.message;
  }
  return null;
}

function errorStatus(err: unknown): 400 | 403 | 404 | 500 | 502 {
  if (err instanceof HttpError) return err.status;
  if (err instanceof InvalidRepoError) return 400;
  if (err instanceof PrNotFoundError) return 404;
  if (err instanceof CommandError) return 502;
  return 500;
}

/**
 * The local HTTP API and the web app. Only this machine's browser, through
 * `127.0.0.1:<port>` or `localhost:<port>`, may use it.
 */
export function createApp(deps: AppDeps): Hono {
  const { github, repos, store, builder, jobs, port } = deps;
  const app = new Hono();

  /** The stored tour; a tour that no longer reads is logged and treated as missing, so it can be rebuilt. */
  function readTour(repo: string, pr: number): Tour | null {
    try {
      return store.getTour(repo, pr);
    } catch (err) {
      if (!(err instanceof StoreError)) throw err;
      console.error(logDetail(err));
      return null;
    }
  }

  function requireTour(repo: string, pr: number): Tour {
    const tour = readTour(repo, pr);
    if (!tour) throw new HttpError(404, `No tour for ${repo}#${pr}`);
    return tour;
  }

  function inboxPr(pr: PrSummary) {
    let tour;
    try {
      tour = store.tourStatus(pr.repo, pr.number);
    } catch (err) {
      // One unreadable tour must not hide the whole inbox; show it as missing.
      if (!(err instanceof StoreError)) throw err;
      console.error(logDetail(err));
      tour = { exists: false };
    }
    return { ...pr, tour, seenCount: store.seenCount(pr.repo, pr.number) };
  }

  // Guard: other web pages in the user's browser can send requests here too.
  // - DNS rebinding: a hostile name that resolves to 127.0.0.1 still sends its own
  //   name as `Host`, so only our exact host and port are accepted.
  // - Cross-site writes: a page cannot set a custom header without a CORS preflight,
  //   which this server never approves, so every write must carry `X-PR-Tour: 1`.
  //
  // Every response, refusals included, also forbids framing, so no page can show the
  // app in an iframe and trick the user into clicking it (clickjacking).
  app.use('*', async (c, next) => {
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    const host = c.req.header('host');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return c.json({ error: 'Forbidden host' }, 403);
    }
    if (c.req.method !== 'GET' && c.req.header('x-pr-tour') !== '1') {
      return c.json({ error: 'Missing X-PR-Tour header' }, 403);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/inbox', async (c) => {
    const inbox = await github.inbox();
    const body: InboxResponse = {
      reviewRequested: inbox.reviewRequested.map(inboxPr),
      mine: inbox.mine.map(inboxPr),
    };
    return c.json(body);
  });

  app.get('/api/pr/:owner/:name/:pr', async (c) => {
    const { repo, pr, key } = prParams(c);
    const summary = await github.pr(repo, pr);
    const tour = readTour(repo, pr);
    const body: PrResponse = {
      pr: summary,
      tour,
      seen: store.seen(repo, pr),
      outdated: tour !== null && tour.headSha !== summary.headSha,
      job: jobs.get(key),
    };
    return c.json(body);
  });

  app.post('/api/pr/:owner/:name/:pr/tour', (c) => {
    const { repo, pr, key } = prParams(c);
    jobs.start(key, async (log) => {
      try {
        await builder.build(repo, pr, log);
      } catch (err) {
        console.error(`Building the tour of ${key} failed:\n${logDetail(err)}`);
        throw new Error(userMessage(err) ?? INTERNAL_ERROR, { cause: err });
      }
    });
    return c.json({ job: jobs.get(key) }, 202);
  });

  app.get('/api/pr/:owner/:name/:pr/file', async (c) => {
    const { repo, pr } = prParams(c);
    const { sha, path } = parse(FileQuerySchema, c.req.query(), 'file query');
    const tour = requireTour(repo, pr);
    // Only the commits of this PR's tour, not any object in the repo cache.
    if (sha !== tour.baseSha && sha !== tour.headSha) {
      throw new HttpError(400, 'sha must be the base or head commit of the tour');
    }
    return c.json({ text: await repos.fileAt(repo, sha, path) });
  });

  app.get('/api/pr/:owner/:name/:pr/diff', async (c) => {
    const { repo, pr } = prParams(c);
    const { file } = parse(DiffQuerySchema, c.req.query(), 'diff query');
    const tour = requireTour(repo, pr);
    const files = parseDiff(await repos.diffText(repo, tour.baseSha, tour.headSha));
    const diff =
      files.find((f) => f.path === file) ?? files.find((f) => f.oldPath === file) ?? null;
    if (!diff) throw new HttpError(404, `${file} is not changed in this tour`);
    return c.json(diff);
  });

  app.post('/api/pr/:owner/:name/:pr/seen', async (c) => {
    const { repo, pr } = prParams(c);
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
    const { homeId, contentHash } = parse(SeenBodySchema, json, 'seen mark');
    if (!homeIds(requireTour(repo, pr)).includes(homeId)) {
      throw new HttpError(400, `${homeId} is not a step of this tour`);
    }
    store.markSeen(repo, pr, homeId, contentHash);
    return c.body(null, 204);
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  const webDir = deps.webDir ?? fileURLToPath(new URL('../web/', import.meta.url));
  if (existsSync(webDir)) {
    app.use('*', serveStatic({ root: webDir }));
    // Client-side routes (`/pr/...`) get the app shell.
    app.get('*', serveStatic({ path: join(webDir, 'index.html') }));
  } else {
    app.get('*', (c) => c.text('The pr-tour web app is not built. Run `npm run build`.', 404));
  }

  app.onError((err, c) => {
    const status = errorStatus(err);
    const message = userMessage(err);
    if (status >= 500) console.error(logDetail(err));
    return c.json({ error: message ?? INTERNAL_ERROR }, status);
  });

  return app;
}
