// HTTP wire types: what the server's /api returns and the web renders.

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
};

/** The user's open PRs: those waiting for their review and their own. */
export type Inbox = { reviewRequested: PrSummary[]; mine: PrSummary[] };

/** Whether a PR has a stored tour, and its size if so. */
export type TourStatus = {
  exists: boolean;
  source?: 'author' | 'inferred';
  headSha?: string;
  /** Number of homes (foundations, steps and other items). */
  homes?: number;
  flows?: number;
};
