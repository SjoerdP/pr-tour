import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, StoreError } from '../../src/server/store.js';
import type { StoredNewDraft } from '../../src/shared/review.js';
import type { Step, Tour } from '../../src/shared/tour.js';

function step(id: string): Step {
  return {
    id,
    title: id,
    file: 'src/a.ts',
    startLine: 1,
    endLine: 2,
    changed: true,
    why: 'w',
    risk: 'skim',
    sideEffects: [],
    tests: [],
    calls: [],
    homes: [{ file: 'src/a.ts', side: 'new', start: 1, end: 2 }],
  };
}

function tour(overrides: Partial<Tour> = {}): Tour {
  return {
    repo: 'acme/loans',
    pr: 7,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    source: 'inferred',
    createdAt: '2026-10-28T12:00:00.000Z',
    summary: 'Adds repayments.',
    foundations: [
      {
        id: 'f1',
        kind: 'migration',
        title: 'Create table',
        file: 'm.sql',
        why: 'w',
        risk: 'read-closely',
        homes: [{ file: 'm.sql', side: 'new', start: 1, end: 3 }],
      },
    ],
    flows: [
      {
        id: 'F1',
        title: 'Repay',
        entry: { kind: 'http', label: 'POST /repay' },
        steps: [step('F1.S1'), step('F1.S2')],
      },
      { id: 'F2', title: 'List', entry: { kind: 'cli', label: 'list' }, steps: [step('F2.S1')] },
    ],
    other: [
      {
        kind: 'docs',
        title: 'Docs',
        summary: 's',
        items: [
          {
            id: 'o1.1',
            file: 'README.md',
            title: 'Readme',
            homes: [{ file: 'README.md', whole: true }],
          },
        ],
      },
    ],
    check: { problems: [] },
    hashes: { f1: 'h-f1', 'F1.S1': 'h-s1', 'F1.S2': 'h-s2', 'F2.S1': 'h-s3', 'o1.1': 'h-o1' },
    ...overrides,
  };
}

describe('Store', () => {
  it('saveTour then getTour round-trips', () => {
    const store = new Store(':memory:');
    const t = tour();
    store.saveTour(t);
    expect(store.getTour('acme/loans', 7)).toEqual(t);
  });

  it('getTour returns null for a PR without a tour', () => {
    const store = new Store(':memory:');
    store.saveTour(tour());
    expect(store.getTour('acme/loans', 8)).toBeNull();
    expect(store.getTour('acme/other', 7)).toBeNull();
  });

  it('saveTour replaces the old tour for the same PR', () => {
    const store = new Store(':memory:');
    store.saveTour(tour());
    const newer = tour({ headSha: 'c'.repeat(40), source: 'author', summary: 'Second try.' });
    store.saveTour(newer);
    expect(store.getTour('acme/loans', 7)).toEqual(newer);
  });

  it('tourStatus counts flows and homes', () => {
    const store = new Store(':memory:');
    store.saveTour(tour());
    expect(store.tourStatus('acme/loans', 7)).toEqual({
      exists: true,
      source: 'inferred',
      headSha: 'b'.repeat(40),
      homes: 5,
      flows: 2,
    });
  });

  it('tourStatus says a missing tour does not exist', () => {
    const store = new Store(':memory:');
    expect(store.tourStatus('acme/loans', 7)).toEqual({ exists: false });
  });

  it('markSeen is idempotent and seen returns the hash', () => {
    const store = new Store(':memory:');
    store.saveTour(tour());
    store.markSeen('acme/loans', 7, 'F1.S1', 'h-s1');
    store.markSeen('acme/loans', 7, 'F1.S1', 'h-s1');
    store.markSeen('acme/loans', 7, 'f1', 'h-f1');
    expect(store.seen('acme/loans', 7)).toEqual({ 'F1.S1': 'h-s1', f1: 'h-f1' });
    expect(store.seenCount('acme/loans', 7)).toBe(2);
  });

  it('markSeen again with a new hash keeps the latest hash', () => {
    const store = new Store(':memory:');
    store.markSeen('acme/loans', 7, 'F1.S1', 'old');
    store.markSeen('acme/loans', 7, 'F1.S1', 'new');
    expect(store.seen('acme/loans', 7)).toEqual({ 'F1.S1': 'new' });
  });

  it('seen marks are kept per PR', () => {
    const store = new Store(':memory:');
    store.markSeen('acme/loans', 7, 'f1', 'h');
    expect(store.seen('acme/loans', 8)).toEqual({});
    expect(store.seenCount('acme/other', 7)).toBe(0);
  });

  it('seen marks survive saveTour', () => {
    const store = new Store(':memory:');
    store.saveTour(tour());
    store.markSeen('acme/loans', 7, 'F1.S1', 'h-s1');
    store.saveTour(tour({ headSha: 'c'.repeat(40) }));
    expect(store.seen('acme/loans', 7)).toEqual({ 'F1.S1': 'h-s1' });
  });
});

describe('Store progress counts only reviewable homes', () => {
  /** The default tour with an unchanged step F1.S3 at the end of flow F1. */
  function tourWithUnchangedStep(): Tour {
    const t = tour();
    const unchanged: Step = { ...step('F1.S3'), changed: false, homes: [] };
    t.flows[0]!.steps.push(unchanged);
    t.hashes['F1.S3'] = 'h-s1-3';
    return t;
  }

  it('tourStatus leaves unchanged steps out of homes', () => {
    const store = new Store(':memory:');
    store.saveTour(tourWithUnchangedStep());
    expect(store.tourStatus('acme/loans', 7).homes).toBe(5);
  });

  it('seenCount ignores a seen mark on an unchanged step', () => {
    const store = new Store(':memory:');
    store.saveTour(tourWithUnchangedStep());
    store.markSeen('acme/loans', 7, 'F1.S1', 'h-s1');
    store.markSeen('acme/loans', 7, 'F1.S3', 'h-s1-3');
    expect(store.seenCount('acme/loans', 7)).toBe(1);
  });

  it('seenCount ignores marks of homes that are not in the tour', () => {
    const store = new Store(':memory:');
    store.saveTour(tour());
    store.markSeen('acme/loans', 7, 'F9.S9', 'gone');
    expect(store.seenCount('acme/loans', 7)).toBe(0);
  });

  it("seenCount ignores a mark whose hash is not the home's current hash", () => {
    const store = new Store(':memory:');
    store.saveTour(tour());
    store.markSeen('acme/loans', 7, 'F1.S1', 'stale');
    store.markSeen('acme/loans', 7, 'f1', 'h-f1');
    expect(store.seenCount('acme/loans', 7)).toBe(1);
  });

  it('progress reads the tour once for both status and seen count', () => {
    const store = new Store(':memory:');
    store.saveTour(tourWithUnchangedStep());
    store.markSeen('acme/loans', 7, 'F1.S1', 'h-s1');
    store.markSeen('acme/loans', 7, 'F1.S3', 'h-s1-3');
    const getTour = vi.spyOn(store, 'getTour');

    const progress = store.progress('acme/loans', 7);

    expect(progress).toEqual({
      tour: { exists: true, source: 'inferred', headSha: 'b'.repeat(40), homes: 5, flows: 2 },
      seenCount: 1,
    });
    expect(getTour).toHaveBeenCalledTimes(1);
  });

  it('progress of a PR without a tour', () => {
    const store = new Store(':memory:');
    expect(store.progress('acme/loans', 7)).toEqual({ tour: { exists: false }, seenCount: 0 });
  });

  it('seenCount is 0 without a tour', () => {
    const store = new Store(':memory:');
    store.markSeen('acme/loans', 7, 'f1', 'h-f1');
    expect(store.seenCount('acme/loans', 7)).toBe(0);
  });
});

describe('Store repo keys', () => {
  it('a tour saved as Acme/Loans is found as acme/loans', () => {
    const store = new Store(':memory:');
    const t = tour({ repo: 'Acme/Loans' });
    store.saveTour(t);

    expect(store.getTour('acme/loans', 7)).toEqual(t);
    expect(store.tourStatus('ACME/LOANS', 7).exists).toBe(true);
    store.close();
  });

  it('seen marks ignore the case of the repo', () => {
    const store = new Store(':memory:');
    store.saveTour(tour());
    store.markSeen('Acme/Loans', 7, 'f1', 'h-f1');

    expect(store.seen('acme/loans', 7)).toEqual({ f1: 'h-f1' });
    expect(store.seenCount('ACME/loans', 7)).toBe(1);
    store.close();
  });
});

describe('Store on disk', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function dbPath(): string {
    dir = mkdtempSync(join(tmpdir(), 'pr-tour-store-'));
    return join(dir, 'pr-tour.db');
  }

  it('keeps tours and seen marks across reopening', () => {
    const path = dbPath();
    const first = new Store(path);
    first.saveTour(tour());
    first.markSeen('acme/loans', 7, 'f1', 'h-f1');
    first.close();
    const second = new Store(path);
    expect(second.getTour('acme/loans', 7)).toEqual(tour());
    expect(second.seen('acme/loans', 7)).toEqual({ f1: 'h-f1' });
    second.close();
  });

  it('getTour throws on a stored tour that does not match the schema', () => {
    const path = dbPath();
    new Store(path).close();
    const db = new Database(path);
    db.prepare(
      `INSERT INTO tours (repo, pr, head_sha, source, json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('acme/loans', 7, 'b'.repeat(40), 'inferred', '{"summary":1}', '2026-10-28T12:00:00.000Z');
    db.close();
    const store = new Store(path);
    expect(() => store.getTour('acme/loans', 7)).toThrow(StoreError);
    store.close();
  });

  it('refuses a database from a newer pr-tour', () => {
    const path = dbPath();
    const db = new Database(path);
    db.pragma('user_version = 99');
    db.close();
    expect(() => new Store(path)).toThrow(/newer/);
  });
});

const comment: StoredNewDraft = {
  kind: 'comment',
  path: 'src/a.ts',
  side: 'new',
  startLine: 3,
  endLine: 5,
  placement: 'line',
  quote: '',
  headSha: 'b'.repeat(40),
  body: 'Why this?',
};
const reply: StoredNewDraft = { kind: 'reply', threadId: 'PRRT_1', body: 'Agreed.' };

describe('Store drafts', () => {
  it('add then list returns both kinds in order', () => {
    const store = new Store(':memory:');
    const c = store.addDraft('acme/loans', 7, comment);
    const r = store.addDraft('acme/loans', 7, reply);

    expect(c).toEqual({ ...comment, id: c.id, createdAt: c.createdAt });
    expect(r).toEqual({ ...reply, id: r.id, createdAt: r.createdAt });
    expect(r.id).toBeGreaterThan(c.id);
    expect(store.drafts('acme/loans', 7)).toEqual([c, r]);
    expect(store.drafts('acme/loans', 8)).toEqual([]);
  });

  it('update changes body', () => {
    const store = new Store(':memory:');
    const c = store.addDraft('acme/loans', 7, comment);
    const updated = store.updateDraft('acme/loans', 7, c.id, 'New text');
    expect(updated).toEqual({ ...c, body: 'New text' });
    expect(store.drafts('acme/loans', 7)).toEqual([updated]);
  });

  it("update of another PR's draft throws", () => {
    const store = new Store(':memory:');
    const c = store.addDraft('acme/loans', 7, comment);
    expect(() => store.updateDraft('acme/loans', 8, c.id, 'x')).toThrow(StoreError);
    expect(() => store.updateDraft('acme/other', 7, c.id, 'x')).toThrow(StoreError);
    expect(() => store.updateDraft('acme/loans', 7, c.id + 99, 'x')).toThrow(StoreError);
    expect(store.drafts('acme/loans', 7)).toEqual([c]);
  });

  it('delete removes one', () => {
    const store = new Store(':memory:');
    const c = store.addDraft('acme/loans', 7, comment);
    const r = store.addDraft('acme/loans', 7, reply);
    store.deleteDraft('acme/loans', 7, c.id);
    store.deleteDraft('acme/loans', 7, 12345);
    store.deleteDraft('acme/loans', 8, r.id);
    expect(store.drafts('acme/loans', 7)).toEqual([r]);
  });

  it('clearDrafts removes only the given ids', () => {
    const store = new Store(':memory:');
    const a = store.addDraft('acme/loans', 7, comment);
    const b = store.addDraft('acme/loans', 7, reply);
    const c = store.addDraft('acme/loans', 7, { ...reply, body: 'Third' });
    const other = store.addDraft('acme/loans', 8, reply);
    store.clearDrafts('acme/loans', 7, [a.id, c.id, other.id]);
    store.clearDrafts('acme/loans', 7, []);
    expect(store.drafts('acme/loans', 7)).toEqual([b]);
    expect(store.drafts('acme/loans', 8)).toEqual([other]);
  });

  it('draftCount', () => {
    const store = new Store(':memory:');
    expect(store.draftCount('acme/loans', 7)).toBe(0);
    store.addDraft('acme/loans', 7, comment);
    store.addDraft('acme/loans', 7, reply);
    store.addDraft('acme/loans', 8, reply);
    expect(store.draftCount('acme/loans', 7)).toBe(2);
  });

  it('repo case is ignored', () => {
    const store = new Store(':memory:');
    const c = store.addDraft('Acme/Loans', 7, comment);
    expect(store.drafts('acme/loans', 7)).toEqual([c]);
    expect(store.draftCount('ACME/LOANS', 7)).toBe(1);
    expect(store.updateDraft('acme/LOANS', 7, c.id, 'x').body).toBe('x');
    store.clearDrafts('ACME/loans', 7, [c.id]);
    expect(store.draftCount('acme/loans', 7)).toBe(0);
  });
});

describe('Store migration', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('an existing version-1 database migrates and keeps tours and seen marks', () => {
    dir = mkdtempSync(join(tmpdir(), 'pr-tour-store-'));
    const path = join(dir, 'pr-tour.db');
    const t = tour();
    const db = new Database(path);
    db.exec(`CREATE TABLE tours (
       repo TEXT NOT NULL, pr INTEGER NOT NULL, head_sha TEXT NOT NULL, source TEXT NOT NULL,
       json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (repo, pr));
     CREATE TABLE seen (
       repo TEXT NOT NULL, pr INTEGER NOT NULL, home_id TEXT NOT NULL,
       content_hash TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (repo, pr, home_id));`);
    db.prepare(
      `INSERT INTO tours (repo, pr, head_sha, source, json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('acme/loans', 7, t.headSha, t.source, JSON.stringify(t), t.createdAt);
    db.prepare(
      `INSERT INTO seen (repo, pr, home_id, content_hash, seen_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('acme/loans', 7, 'f1', 'h-f1', '2026-10-28T12:00:00.000Z');
    db.pragma('user_version = 1');
    db.close();

    const store = new Store(path);
    expect(store.getTour('acme/loans', 7)).toEqual(t);
    expect(store.seen('acme/loans', 7)).toEqual({ f1: 'h-f1' });
    const c = store.addDraft('acme/loans', 7, comment);
    expect(store.drafts('acme/loans', 7)).toEqual([c]);
    store.close();

    const check = new Database(path);
    expect(check.pragma('user_version', { simple: true })).toBe(2);
    check.close();
  });
});
