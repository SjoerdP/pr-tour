// A PR's review on GitHub: reads threads, CI status and authorship; submits reviews and
// resolves threads.

import {
  fileCommentBody,
  isOlderDraft,
  type CiStatus,
  type Draft,
  type DraftComment,
  type ReviewEvent,
  type ReviewThread,
  type ThreadComment,
} from '../shared/review.js';
import { CommandError, runOk, type Runner } from './exec.js';
import { ghGraphql, GraphqlError, prGraphql, PrNotFoundError } from './graphql.js';

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

// Mutations. Every value goes in as a variable; `-f` keeps strings (a body "123" stays a
// string), `-F` is only for line numbers.
const START_REVIEW = `mutation($prId: ID!, $commitOid: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $prId, commitOID: $commitOid }) {
    pullRequestReview { id }
  }
}`;

const ADD_THREAD = `mutation(
  $reviewId: ID!, $path: String!, $body: String!,
  $subjectType: PullRequestReviewThreadSubjectType!,
  $line: Int, $side: DiffSide, $startLine: Int, $startSide: DiffSide
) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $reviewId, path: $path, body: $body, subjectType: $subjectType,
    line: $line, side: $side, startLine: $startLine, startSide: $startSide
  }) { thread { id } }
}`;

const ADD_REPLY = `mutation($reviewId: ID!, $threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewId: $reviewId, pullRequestReviewThreadId: $threadId, body: $body
  }) { comment { id } }
}`;

const SUBMIT_REVIEW = `mutation($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
    pullRequestReview { url }
  }
}`;

const DELETE_REVIEW = `mutation($reviewId: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) { clientMutationId }
}`;

const RESOLVE_THREAD = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

const UNRESOLVE_THREAD = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

/**
 * Submitting a review failed; the pending review was deleted. `failedDraftId` is the draft
 * GitHub refused, or null when the failure was not about one draft.
 */
export class ReviewSubmitError extends Error {
  constructor(
    message: string,
    readonly failedDraftId: number | null,
    options?: { cause: unknown },
  ) {
    super(message, options);
    this.name = 'ReviewSubmitError';
  }
}

/** A short message for a failed gh call, fit to show the user. */
function shortMessage(err: unknown): string {
  if (err instanceof CommandError) return err.shortMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Run mutation `name` and return its result. GitHub can answer a failed mutation with a
 * null result next to its errors, which `ghGraphql` would hand back as data; that throws
 * `GraphqlError` with GitHub's first error message.
 */
async function mutate<T>(run: Runner, name: string, query: string, fields: string[]): Promise<T> {
  const { stdout } = await runOk(run, 'gh', ['api', 'graphql', '-f', `query=${query}`, ...fields]);
  const response = JSON.parse(stdout) as {
    data?: Record<string, T | null> | null;
    errors?: { message: string }[];
  };
  const result = response.data?.[name];
  if (result == null) {
    throw new GraphqlError(
      response.errors?.[0]?.message ?? `GitHub returned no result for ${name}`,
    );
  }
  return result;
}

/** The `gh api` fields that add `draft` as a thread to review `reviewId`. */
function threadFields(reviewId: string, draft: DraftComment, commitOid: string): string[] {
  const common = ['-f', `reviewId=${reviewId}`, '-f', `path=${draft.path}`];
  // A draft made on an older head may not match this head's lines; quote them instead.
  if (draft.placement === 'file' || isOlderDraft(draft, commitOid)) {
    const { path, side, startLine, endLine, quote, body } = draft;
    return [
      ...common,
      '-f',
      `body=${fileCommentBody(path, side, startLine, endLine, quote, body)}`,
      '-f',
      'subjectType=FILE',
    ];
  }
  const side = draft.side === 'old' ? 'LEFT' : 'RIGHT';
  const fields = [
    ...common,
    '-f',
    `body=${draft.body}`,
    '-f',
    'subjectType=LINE',
    '-F',
    `line=${draft.endLine}`,
    '-f',
    `side=${side}`,
  ];
  if (draft.startLine < draft.endLine) {
    fields.push('-F', `startLine=${draft.startLine}`, '-f', `startSide=${side}`);
  }
  return fields;
}

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

/** A PR's review on GitHub, through the user's own `gh` login. */
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

  /**
   * Post `drafts` in order as one review on `commitOid`, then submit it with `event` and
   * `body`. Any failure deletes the pending review and throws `ReviewSubmitError`.
   */
  async submitReview(args: {
    prId: string;
    commitOid: string;
    event: ReviewEvent;
    body: string;
    drafts: Draft[];
  }): Promise<{ url: string }> {
    let reviewId: string;
    try {
      const result = await mutate<{ pullRequestReview: { id: string } }>(
        this.run,
        'addPullRequestReview',
        START_REVIEW,
        ['-f', `prId=${args.prId}`, '-f', `commitOid=${args.commitOid}`],
      );
      reviewId = result.pullRequestReview.id;
    } catch (err) {
      throw new ReviewSubmitError(`Couldn't start your review: ${shortMessage(err)}`, null, {
        cause: err,
      });
    }

    for (const draft of args.drafts) {
      try {
        if (draft.kind === 'comment') {
          await mutate(
            this.run,
            'addPullRequestReviewThread',
            ADD_THREAD,
            threadFields(reviewId, draft, args.commitOid),
          );
        } else {
          await mutate(this.run, 'addPullRequestReviewThreadReply', ADD_REPLY, [
            '-f',
            `reviewId=${reviewId}`,
            '-f',
            `threadId=${draft.threadId}`,
            '-f',
            `body=${draft.body}`,
          ]);
        }
      } catch (err) {
        await this.deleteReview(reviewId);
        const what = draft.kind === 'comment' ? `your comment on ${draft.path}` : 'your reply';
        throw new ReviewSubmitError(`Couldn't add ${what}: ${shortMessage(err)}`, draft.id, {
          cause: err,
        });
      }
    }

    try {
      const result = await mutate<{ pullRequestReview: { url: string } }>(
        this.run,
        'submitPullRequestReview',
        SUBMIT_REVIEW,
        ['-f', `reviewId=${reviewId}`, '-f', `event=${args.event}`, '-f', `body=${args.body}`],
      );
      return { url: result.pullRequestReview.url };
    } catch (err) {
      await this.deleteReview(reviewId);
      throw new ReviewSubmitError(`Couldn't submit your review: ${shortMessage(err)}`, null, {
        cause: err,
      });
    }
  }

  /** Resolve or unresolve review thread `threadId`. */
  async setResolved(threadId: string, resolved: boolean): Promise<void> {
    const [name, query] = resolved
      ? ['resolveReviewThread', RESOLVE_THREAD]
      : ['unresolveReviewThread', UNRESOLVE_THREAD];
    await mutate(this.run, name, query, ['-f', `threadId=${threadId}`]);
  }

  /** Delete pending review `reviewId` after a failed submit. */
  private async deleteReview(reviewId: string): Promise<void> {
    try {
      await mutate(this.run, 'deletePullRequestReview', DELETE_REVIEW, [
        '-f',
        `reviewId=${reviewId}`,
      ]);
    } catch (err) {
      // The submit error matters more to the user; a pending review left behind only shows
      // to them on GitHub, so log it and go on.
      console.error(`Deleting pending review ${reviewId} failed: ${String(err)}`);
    }
  }
}
