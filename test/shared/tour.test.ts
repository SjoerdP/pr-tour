import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TourBodyInputSchema,
  TourBodySchema,
  TourSchema,
  homeIds,
  lastChangedStepIndex,
  reviewableHomeIds,
  tourBodyJsonSchema,
  type Flow,
  type Step,
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

  it('a flow may have a why; a body without one still parses', () => {
    const body = fixture();
    expect(body.flows[0]!.why).toBeUndefined();
    body.flows[0]!.why = 'The repay path.';
    expect(TourBodyInputSchema.parse(body).flows[0]!.why).toBe('The repay path.');
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

describe('reviewableHomeIds', () => {
  it('leaves out unchanged steps: they have no changed lines', () => {
    expect(reviewableHomeIds(TourBodySchema.parse(bodyWithIds()))).toEqual(['f1', 'F1.S1', 'o1.1']);
  });

  it('leaves out any home without changed-line ranges', () => {
    const body = bodyWithIds();
    body.foundations[0]!.homes = [];
    body.other[0]!.items[0]!.homes = [];
    expect(reviewableHomeIds(TourBodySchema.parse(body))).toEqual(['F1.S1']);
  });
});

describe('lastChangedStepIndex', () => {
  function flowOf(...changed: boolean[]): Flow {
    const steps = changed.map((c, i): Step => ({
      id: `F1.S${i + 1}`,
      title: `step ${i + 1}`,
      file: 'a.ts',
      startLine: 1,
      endLine: 2,
      changed: c,
      why: 'w',
      risk: 'skim',
      sideEffects: [],
      tests: [],
      calls: [],
      homes: c ? [{ file: 'a.ts', side: 'new', start: 1, end: 2 }] : [],
    }));
    return { id: 'F1', title: 'Flow', entry: { kind: 'http', label: 'GET /' }, steps };
  }

  it('is the index of the last step with homes', () => {
    expect(lastChangedStepIndex(flowOf(true, false, true, false, false))).toBe(2);
  });

  it('is the last index when the last step is changed', () => {
    expect(lastChangedStepIndex(flowOf(false, true))).toBe(1);
  });

  it('is -1 when no step has homes', () => {
    expect(lastChangedStepIndex(flowOf(false, false))).toBe(-1);
    expect(lastChangedStepIndex(flowOf())).toBe(-1);
  });
});
