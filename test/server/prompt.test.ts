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
