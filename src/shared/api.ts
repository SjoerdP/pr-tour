// HTTP wire types: what the server's /api returns and the web renders.

import type { CiStatus } from './review.js';
import type { Tour } from './tour.js';

/** One pull request as listed in the inbox and shown above a tour. */
export type PrSummary = {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  additions: number;
  deletions: number;
  isDraft: boolean;
  /** ISO 8601 timestamp. */
  updatedAt: string;
  baseSha: string;
  headSha: string;
  /** The user wrote this PR (GitHub does not let authors approve or request changes). */
  viewerIsAuthor: boolean;
};

/** A PR as the inbox lists it: its summary and the CI status of its head. */
export type InboxSummary = PrSummary & { ci: CiStatus };

/** The user's open PRs: those waiting for their review and their own. */
export type Inbox = { reviewRequested: InboxSummary[]; mine: InboxSummary[] };

/** Whether a PR has a stored tour, and its size if so. */
export type TourStatus = {
  exists: boolean;
  source?: 'author' | 'inferred';
  headSha?: string;
  /** Number of reviewable homes: those with changed lines (unchanged flow steps do not count). */
  homes?: number;
  flows?: number;
};

/** A tour build running in the server. `log` holds its last 50 lines. */
export type Job = {
  state: 'running' | 'done' | 'failed';
  /** Short, readable reason when `state` is `failed`. */
  error?: string;
  log: string[];
};

/**
 * An inbox PR with its CI status, its tour status, how many of its homes the user has
 * seen, and how many review drafts the user has on it.
 */
export type InboxPr = InboxSummary & { tour: TourStatus; seenCount: number; drafts: number };

export type InboxResponse = { reviewRequested: InboxPr[]; mine: InboxPr[] };

export type PrResponse = {
  pr: PrSummary;
  tour: Tour | null;
  /** `homeId → contentHash` of every seen home. */
  seen: Record<string, string>;
  /** The PR has commits the stored tour was not built from. */
  outdated: boolean;
  /** The PR's latest build job, if one ran since the server started. */
  job: Job | null;
};
