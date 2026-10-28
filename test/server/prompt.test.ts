import { describe, expect, it } from 'vitest';
import type { PrSummary } from '../../src/shared/api.js';
import { tourPrompt, tourRules } from '../../src/server/prompt.js';

const pr: PrSummary = {
  repo: 'acme/api',
  number: 12,
  title: 'Add early repayment',
  author: 'jane',
  url: 'https://github.com/acme/api/pull/12',
  additions: 10,
  deletions: 2,
  isDraft: false,
  updatedAt: '2026-10-28T10:00:00Z',
  baseSha: 'b'.repeat(40),
  headSha: 'a'.repeat(40),
  viewerIsAuthor: false,
};

describe('tourPrompt', () => {
  it('embeds the tour rules verbatim', () => {
    const prompt = tourPrompt({ diffPath: '/tmp/x/pr.diff', pr, jsonSchema: {} });
    expect(prompt).toContain(tourRules());
  });

  it('embeds the JSON schema and the retry error', () => {
    const prompt = tourPrompt({
      diffPath: '/tmp/x/pr.diff',
      pr,
      jsonSchema: { title: 'marker-schema' },
      retryError: 'marker-error',
    });
    expect(prompt).toContain('"title": "marker-schema"');
    expect(prompt).toContain('marker-error');
  });
});

describe('tourRules', () => {
  it('follows a call into another service of the same repo instead of stopping at it', () => {
    const rules = tourRules();
    expect(rules).toMatch(/same repo/i);
    expect(rules).toMatch(/"external-call" side effect only for services outside\s+this repo/);
  });
});

describe('tourRules: flow ends', () => {
  it('follows each flow to its end: a returned response, a DB write or an outside call', () => {
    const rules = tourRules();
    expect(rules).toMatch(/follow each flow until it ends/i);
    expect(rules).toMatch(/response is returned/);
    expect(rules).toMatch(/written to the database/);
    expect(rules).toMatch(/call to a service outside this repo/);
  });

  it('keeps unchanged steps that do real work and skips small helpers', () => {
    const rules = tourRules();
    expect(rules).toMatch(/unchanged steps that do real work/i);
    expect(rules).toMatch(/skip small helpers \(formatting, logging, getters\)/i);
  });
});
