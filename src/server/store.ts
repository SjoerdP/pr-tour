import Database from 'better-sqlite3';
import type { TourStatus } from '../shared/api.js';
import type { DiffSide, Draft, StoredNewDraft } from '../shared/review.js';
import { reviewableHomeIds, TourSchema, type Tour } from '../shared/tour.js';

export type { TourStatus } from '../shared/api.js';

/**
 * Schema migrations. `MIGRATIONS[n]` takes the database from version `n` to
 * `n + 1`; the version is kept in `PRAGMA user_version`. To change the
 * tables, append a step; never edit an old one.
 */
const MIGRATIONS = [
  `CREATE TABLE tours (
     repo TEXT NOT NULL,
     pr INTEGER NOT NULL,
     head_sha TEXT NOT NULL,
     source TEXT NOT NULL,
     json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (repo, pr)
   );
   CREATE TABLE seen (
     repo TEXT NOT NULL,
     pr INTEGER NOT NULL,
     home_id TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     seen_at TEXT NOT NULL,
     PRIMARY KEY (repo, pr, home_id)
   );`,
  `CREATE TABLE drafts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     repo TEXT NOT NULL,
     pr INTEGER NOT NULL,
     kind TEXT NOT NULL,
     path TEXT,
     side TEXT,
     start_line INTEGER,
     end_line INTEGER,
     placement TEXT,
     quote TEXT,
     head_sha TEXT,
     thread_id TEXT,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX drafts_pr ON drafts(repo, pr);`,
];

const SCHEMA_VERSION = MIGRATIONS.length;

/** Rows are keyed by the lowercased repo: GitHub repo names ignore case. */
function repoKey(repo: string): string {
  return repo.toLowerCase();
}

type DraftRow = {
  id: number;
  kind: string;
  path: string | null;
  side: string | null;
  start_line: number | null;
  end_line: number | null;
  placement: string | null;
  quote: string | null;
  head_sha: string | null;
  thread_id: string | null;
  body: string;
  created_at: string;
};

function draftOf(row: DraftRow): Draft {
  if (row.kind === 'reply') {
    return {
      id: row.id,
      kind: 'reply',
      threadId: row.thread_id ?? '',
      body: row.body,
      createdAt: row.created_at,
    };
  }
  return {
    id: row.id,
    kind: 'comment',
    path: row.path ?? '',
    side: row.side as DiffSide,
    startLine: row.start_line ?? 0,
    endLine: row.end_line ?? 0,
    placement: row.placement as 'line' | 'file',
    quote: row.quote ?? '',
    headSha: row.head_sha ?? '',
    body: row.body,
    createdAt: row.created_at,
  };
}

function statusOf(tour: Tour | null): TourStatus {
  if (!tour) return { exists: false };
  return {
    exists: true,
    source: tour.source,
    headSha: tour.headSha,
    homes: reviewableHomeIds(tour).length,
    flows: tour.flows.length,
  };
}

export class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
  }
}

/**
 * Tours, per-home seen marks and review drafts, in SQLite. One tour per
 * `(repo, pr)`; saving a new tour leaves the seen marks and drafts alone so
 * seen marks can be matched to the new tour by content hash. Drafts are local
 * only until the review is submitted.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma('journal_mode = WAL');
      this.migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Store `tour`, replacing any earlier tour of the same PR. */
  saveTour(tour: Tour): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tours (repo, pr, head_sha, source, json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repoKey(tour.repo),
        tour.pr,
        tour.headSha,
        tour.source,
        JSON.stringify(tour),
        tour.createdAt,
      );
  }

  getTour(repo: string, pr: number): Tour | null {
    const row = this.db
      .prepare(`SELECT json FROM tours WHERE repo = ? AND pr = ?`)
      .get(repoKey(repo), pr) as { json: string } | undefined;
    if (!row) return null;
    try {
      return TourSchema.parse(JSON.parse(row.json));
    } catch (err) {
      throw new StoreError(`Stored tour for ${repo}#${pr} is invalid`, { cause: err });
    }
  }

  tourStatus(repo: string, pr: number): TourStatus {
    return statusOf(this.getTour(repo, pr));
  }

  /** The tour's status and seen count for the inbox, from one read of the tour. */
  progress(repo: string, pr: number): { tour: TourStatus; seenCount: number } {
    const tour = this.getTour(repo, pr);
    return { tour: statusOf(tour), seenCount: this.countSeen(repo, pr, tour) };
  }

  /** Mark a home as seen at `contentHash`; marking again keeps the latest hash. */
  markSeen(repo: string, pr: number, homeId: string, contentHash: string): void {
    this.db
      .prepare(
        `INSERT INTO seen (repo, pr, home_id, content_hash, seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo, pr, home_id)
         DO UPDATE SET content_hash = excluded.content_hash, seen_at = excluded.seen_at`,
      )
      .run(repoKey(repo), pr, homeId, contentHash, new Date().toISOString());
  }

  /** `homeId → contentHash` of every seen home of the PR. */
  seen(repo: string, pr: number): Record<string, string> {
    const rows = this.db
      .prepare(`SELECT home_id, content_hash FROM seen WHERE repo = ? AND pr = ?`)
      .all(repoKey(repo), pr) as { home_id: string; content_hash: string }[];
    return Object.fromEntries(rows.map((r) => [r.home_id, r.content_hash]));
  }

  /**
   * How many of the stored tour's reviewable homes are seen at their current content hash
   * (0 without a tour), matching what the outline shows. Marks on unchanged steps, on homes no
   * longer in the tour, or with an old hash do not count.
   */
  seenCount(repo: string, pr: number): number {
    return this.countSeen(repo, pr, this.getTour(repo, pr));
  }

  private countSeen(repo: string, pr: number, tour: Tour | null): number {
    if (!tour) return 0;
    const seen = this.seen(repo, pr);
    return reviewableHomeIds(tour).filter(
      (id) => tour.hashes[id] !== undefined && seen[id] === tour.hashes[id],
    ).length;
  }

  /** Save a new draft for the PR and return it with its id and creation time. */
  addDraft(repo: string, pr: number, draft: StoredNewDraft): Draft {
    const createdAt = new Date().toISOString();
    const c = draft.kind === 'comment' ? draft : null;
    const result = this.db
      .prepare(
        `INSERT INTO drafts (repo, pr, kind, path, side, start_line, end_line, placement, quote,
           head_sha, thread_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repoKey(repo),
        pr,
        draft.kind,
        c?.path ?? null,
        c?.side ?? null,
        c?.startLine ?? null,
        c?.endLine ?? null,
        c?.placement ?? null,
        c?.quote ?? null,
        c?.headSha ?? null,
        draft.kind === 'reply' ? draft.threadId : null,
        draft.body,
        createdAt,
      );
    return { ...draft, id: Number(result.lastInsertRowid), createdAt };
  }

  /** Change a draft's body. Throws `StoreError` when the PR has no draft with that id. */
  updateDraft(repo: string, pr: number, id: number, body: string): Draft {
    const row = this.db
      .prepare(`UPDATE drafts SET body = ? WHERE id = ? AND repo = ? AND pr = ? RETURNING *`)
      .get(body, id, repoKey(repo), pr) as DraftRow | undefined;
    if (!row) throw new StoreError(`No draft ${id} on ${repo}#${pr}`);
    return draftOf(row);
  }

  /** Remove a draft of the PR; does nothing when it is not there. */
  deleteDraft(repo: string, pr: number, id: number): void {
    this.db
      .prepare(`DELETE FROM drafts WHERE id = ? AND repo = ? AND pr = ?`)
      .run(id, repoKey(repo), pr);
  }

  /** The PR's drafts, oldest first. */
  drafts(repo: string, pr: number): Draft[] {
    const rows = this.db
      .prepare(`SELECT * FROM drafts WHERE repo = ? AND pr = ? ORDER BY id`)
      .all(repoKey(repo), pr) as DraftRow[];
    return rows.map(draftOf);
  }

  draftCount(repo: string, pr: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM drafts WHERE repo = ? AND pr = ?`)
      .get(repoKey(repo), pr) as { n: number };
    return row.n;
  }

  /** Remove the given drafts of the PR (the ones a submitted review sent). */
  clearDrafts(repo: string, pr: number, ids: number[]): void {
    const remove = this.db.prepare(`DELETE FROM drafts WHERE id = ? AND repo = ? AND pr = ?`);
    const key = repoKey(repo);
    this.db.transaction(() => {
      for (const id of ids) remove.run(id, key, pr);
    })();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new StoreError(
        `Database schema version ${version} is newer than this pr-tour supports (${SCHEMA_VERSION})`,
      );
    }
    this.db.transaction(() => {
      for (const step of MIGRATIONS.slice(version)) this.db.exec(step);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
}
