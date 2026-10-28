import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, StoreError } from '../../src/server/store.js';
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
    store.markSeen('Acme/Loans', 7, 'f1', 'h1');

    expect(store.seen('acme/loans', 7)).toEqual({ f1: 'h1' });
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
