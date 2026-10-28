import Database from 'better-sqlite3';
import type { TourStatus } from '../shared/api.js';
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
];

const SCHEMA_VERSION = MIGRATIONS.length;

/** Rows are keyed by the lowercased repo: GitHub repo names ignore case. */
function repoKey(repo: string): string {
  return repo.toLowerCase();
}

export class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
  }
}

/**
 * Tours and per-home seen marks, in SQLite. One tour per `(repo, pr)`; saving
 * a new tour leaves the seen marks alone so they can be matched to the new
 * tour by content hash.
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
    const tour = this.getTour(repo, pr);
    if (!tour) return { exists: false };
    return {
      exists: true,
      source: tour.source,
      headSha: tour.headSha,
      homes: reviewableHomeIds(tour).length,
      flows: tour.flows.length,
    };
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
   * How many of the stored tour's reviewable homes have a seen mark (0 without a tour).
   * Marks on unchanged steps, or on homes no longer in the tour, do not count.
   */
  seenCount(repo: string, pr: number): number {
    const tour = this.getTour(repo, pr);
    if (!tour) return 0;
    const seen = this.seen(repo, pr);
    return reviewableHomeIds(tour).filter((id) => Object.hasOwn(seen, id)).length;
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
