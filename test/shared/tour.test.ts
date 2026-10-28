import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TourBodyInputSchema,
  TourBodySchema,
  TourSchema,
  homeIds,
  tourBodyJsonSchema,
  type TourBodyInput,
} from '../../src/shared/tour.js';

// Claude's raw output: no ids yet.
function fixture(): TourBodyInput {
  return JSON.parse(
    readFileSync(new URL('../fixtures/tour-body.json', import.meta.url), 'utf8'),
  ) as TourBodyInput;
}

// The fixture with ids as the builder will assign them.
function bodyWithIds() {
  const body = fixture();
  body.foundations.forEach((f, i) => (f.id = `f${i + 1}`));
  body.flows.forEach((flow, i) => {
    flow.id = `F${i + 1}`;
    flow.steps.forEach((s, j) => (s.id = `F${i + 1}.S${j + 1}`));
  });
  body.other.forEach((g, i) => g.items.forEach((item, j) => (item.id = `o${i + 1}.${j + 1}`)));
  return body;
}

const meta = {
  repo: 'acme/loans',
  pr: 7,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  source: 'inferred',
  createdAt: '2026-10-28T12:00:00.000Z',
};

describe('TourBodyInputSchema', () => {
  it('parses a valid body', () => {
    expect(() => TourBodyInputSchema.parse(fixture())).not.toThrow();
  });

  it('rejects a step without why', () => {
    const body = fixture() as unknown as { flows: { steps: Record<string, unknown>[] }[] };
    delete body.flows[0]!.steps[0]!.why;
    expect(TourBodyInputSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an unknown risk', () => {
    const body = fixture() as unknown as { flows: { steps: Record<string, unknown>[] }[] };
    body.flows[0]!.steps[0]!.risk = 'maybe';
    expect(TourBodyInputSchema.safeParse(body).success).toBe(false);
  });

  it('accepts a whole-file range', () => {
    const body = fixture();
    body.other[0]!.items[0]!.homes = [{ file: 'logo.png', whole: true }];
    const parsed = TourBodyInputSchema.parse(body);
    expect(parsed.other[0]!.items[0]!.homes).toEqual([{ file: 'logo.png', whole: true }]);
  });

  it('rejects a range that ends before it starts', () => {
    const body = fixture();
    body.foundations[0]!.homes = [{ file: 'a.sql', side: 'new', start: 5, end: 4 }];
    expect(TourBodyInputSchema.safeParse(body).success).toBe(false);
  });

  it('rejects line 0: lines are 1-based', () => {
    const body = fixture();
    body.foundations[0]!.homes = [{ file: 'a.sql', side: 'new', start: 0, end: 3 }];
    expect(TourBodyInputSchema.safeParse(body).success).toBe(false);
  });

  it('accepts a single-line range', () => {
    const body = fixture();
    body.foundations[0]!.homes = [{ file: 'a.sql', side: 'old', start: 3, end: 3 }];
    expect(TourBodyInputSchema.safeParse(body).success).toBe(true);
  });
});

describe('TourBodySchema', () => {
  it('requires ids, unlike the input schema', () => {
    expect(TourBodySchema.safeParse(fixture()).success).toBe(false);
    expect(TourBodySchema.safeParse(bodyWithIds()).success).toBe(true);
  });
});

describe('TourSchema', () => {
  it('parses a body with meta, check and hashes', () => {
    const tour = { ...bodyWithIds(), ...meta, check: { problems: [] }, hashes: { f1: 'h1' } };
    expect(TourSchema.parse(tour)).toEqual(tour);
  });

  it('rejects a tour without meta', () => {
    const tour = { ...bodyWithIds(), check: { problems: [] }, hashes: {} };
    expect(TourSchema.safeParse(tour).success).toBe(false);
  });
});

describe('tourBodyJsonSchema', () => {
  it('json schema has flows', () => {
    const schema = tourBodyJsonSchema() as { properties?: Record<string, unknown> };
    expect(schema.properties?.flows).toBeDefined();
  });
});

describe('homeIds', () => {
  it('homeIds lists all homes in order', () => {
    const tour = TourSchema.parse({
      ...bodyWithIds(),
      ...meta,
      check: { problems: [] },
      hashes: {},
    });
    expect(homeIds(tour)).toEqual(['f1', 'F1.S1', 'F1.S2', 'o1.1']);
  });
});
