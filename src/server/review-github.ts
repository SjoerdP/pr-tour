// Reads a PR's review state from GitHub: review threads, CI status and authorship.

import type { CiStatus, ReviewThread, ThreadComment } from '../shared/review.js';
import type { Runner } from './exec.js';
import { ghGraphql, prGraphql, PrNotFoundError } from './graphql.js';

/** Selects the CI rollup of the PR's last commit; `commitsRollup` reads it back. */
export const CI_FIELDS = `
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name conclusion detailsUrl }
    ... on StatusContext { context state targetUrl }
  } } } } } }
`;

const COMMENT_FIELDS = `pageInfo { hasNextPage endCursor } nodes { id author { login } body createdAt url }`;

const REVIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id viewerDidAuthor
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine diffSide subjectType
          comments(first: 100) { ${COMMENT_FIELDS} }
        }
      }
      ${CI_FIELDS}
    }
  }
}`;

const COMMENTS_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { ${COMMENT_FIELDS} } }
  }
}`;

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };

type CommentNode = {
  id: string;
  /** Null when the author's account was deleted. */
  author: { login: string } | null;
  body: string;
  createdAt: string;
  url: string;
};

type ThreadNode = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  subjectType: 'LINE' | 'FILE' | null;
  comments: Page<CommentNode>;
};

type ContextNode =
  | { __typename: 'CheckRun'; name: string; conclusion: string | null; detailsUrl: string | null }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string | null };

/** The `statusCheckRollup` of a commit; null when the commit has no checks or statuses. */
export type Rollup = { state: string; contexts: { nodes: ContextNode[] } } | null;

/** What `CI_FIELDS` selects. */
export type CommitsWithRollup = { nodes: { commit: { statusCheckRollup: Rollup } }[] };

type ReviewData = {
  repository: {
    pullRequest: {
      id: string;
      viewerDidAuthor: boolean;
      reviewThreads: Page<ThreadNode>;
      commits: CommitsWithRollup;
    } | null;
  } | null;
};

type CommentsData = { node: { comments: Page<CommentNode> } | null };

const FAILED_CHECK = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED']);
const FAILED_STATUS = new Set(['FAILURE', 'ERROR']);

/** The CI status from a commit's status check rollup. */
export function ciStatus(rollup: Rollup): CiStatus {
  if (!rollup) return { state: 'none', failing: null };
  return { state: ciState(rollup.state), failing: firstFailing(rollup.contexts.nodes) };
}

/** The rollup of the last commit `CI_FIELDS` selected. */
export function commitsRollup(commits: CommitsWithRollup): Rollup {
  return commits.nodes[0]?.commit.statusCheckRollup ?? null;
}

function ciState(state: string): CiStatus['state'] {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

function firstFailing(contexts: ContextNode[]): CiStatus['failing'] {
  for (const c of contexts) {
    if (c.__typename === 'CheckRun' && c.conclusion !== null && FAILED_CHECK.has(c.conclusion)) {
      return { name: c.name, url: c.detailsUrl ?? '' };
    }
    if (c.__typename === 'StatusContext' && FAILED_STATUS.has(c.state)) {
      return { name: c.context, url: c.targetUrl ?? '' };
    }
  }
  return null;
}

function toComment(node: CommentNode): ThreadComment {
  return {
    id: node.id,
    // GitHub shows deleted accounts as "ghost".
    author: node.author?.login ?? 'ghost',
    body: node.body,
    createdAt: node.createdAt,
    url: node.url,
  };
}

function toThread(node: ThreadNode, comments: CommentNode[]): ReviewThread {
  const fileLevel = node.subjectType === 'FILE' || node.line === null;
  return {
    id: node.id,
    path: node.path,
    side: fileLevel ? null : node.diffSide === 'LEFT' ? 'old' : 'new',
    line: fileLevel ? null : node.line,
    startLine: fileLevel ? null : node.startLine,
    outdated: node.isOutdated,
    resolved: node.isResolved,
    comments: comments.map(toComment),
  };
}

/** Reads review state through the user's own `gh` login. Read-only. */
export class ReviewGitHub {
  constructor(private readonly run: Runner) {}

  /** The PR's node id, whether the user wrote it, all its review threads and its CI status. */
  async reviewState(
    repo: string,
    pr: number,
  ): Promise<{ prId: string; viewerIsAuthor: boolean; threads: ReviewThread[]; ci: CiStatus }> {
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;
    for (;;) {
      const fields: string[] = cursor === null ? [] : ['-f', `cursor=${cursor}`];
      const data: ReviewData = await prGraphql<ReviewData>(
        this.run,
        repo,
        pr,
        REVIEW_QUERY,
        fields,
      );
      const node = data.repository?.pullRequest;
      if (!node) throw new PrNotFoundError(repo, pr);
      for (const thread of node.reviewThreads.nodes) {
        threads.push(toThread(thread, await this.allComments(thread)));
      }
      const { hasNextPage, endCursor } = node.reviewThreads.pageInfo;
      if (!hasNextPage || endCursor === null) {
        return {
          prId: node.id,
          viewerIsAuthor: node.viewerDidAuthor,
          threads,
          ci: ciStatus(commitsRollup(node.commits)),
        };
      }
      cursor = endCursor;
    }
  }

  /** Every comment of `thread`, fetching the pages after the first. */
  private async allComments(thread: ThreadNode): Promise<CommentNode[]> {
    const comments = [...thread.comments.nodes];
    let { hasNextPage, endCursor } = thread.comments.pageInfo;
    while (hasNextPage && endCursor !== null) {
      const data = await ghGraphql<CommentsData>(this.run, COMMENTS_QUERY, [
        '-f',
        `id=${thread.id}`,
        '-f',
        `cursor=${endCursor}`,
      ]);
      const page = data.node?.comments;
      // The thread was deleted while we read it; keep the comments we already have.
      if (!page) break;
      comments.push(...page.nodes);
      ({ hasNextPage, endCursor } = page.pageInfo);
    }
    return comments;
  }
}
