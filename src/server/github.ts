import type { Inbox, InboxSummary, PrSummary } from '../shared/api.js';
import type { Runner } from './exec.js';
import { ghGraphql, prGraphql, PrNotFoundError } from './graphql.js';
import { CI_FIELDS, ciStatus, commitsRollup, type CommitsWithRollup } from './review-github.js';

export type { Inbox, InboxSummary, PrSummary } from '../shared/api.js';
export { InvalidRepoError, PrNotFoundError } from './graphql.js';

const PR_FIELDS = `
  number title url additions deletions isDraft updatedAt baseRefOid headRefOid viewerDidAuthor
  repository { nameWithOwner }
  author { login }
`;

const INBOX_QUERY = `query {
  reviewRequested: search(query: "is:pr is:open review-requested:@me", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${PR_FIELDS} ${CI_FIELDS} } }
  }
  mine: search(query: "is:pr is:open author:@me", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${PR_FIELDS} ${CI_FIELDS} } }
  }
}`;

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PR_FIELDS} }
  }
}`;

/** A pull request node as selected by `PR_FIELDS`. */
type PrNode = {
  number: number;
  title: string;
  url: string;
  additions: number;
  deletions: number;
  isDraft: boolean;
  updatedAt: string;
  baseRefOid: string;
  headRefOid: string;
  viewerDidAuthor: boolean;
  repository: { nameWithOwner: string };
  /** Null when the author's account was deleted. */
  author: { login: string } | null;
};

/** An inbox node: `PR_FIELDS` plus `CI_FIELDS`. */
type InboxNode = PrNode & { commits: CommitsWithRollup };

/** Search results can hold issues too; the `... on PullRequest` fragment leaves those as `{}`. */
type SearchResult = { nodes: (InboxNode | Record<string, never>)[] };

type InboxData = { reviewRequested: SearchResult; mine: SearchResult };
type PrData = { repository: { pullRequest: PrNode | null } | null };

function toSummary(node: PrNode): PrSummary {
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    // GitHub shows deleted accounts as "ghost".
    author: node.author?.login ?? 'ghost',
    url: node.url,
    additions: node.additions,
    deletions: node.deletions,
    isDraft: node.isDraft,
    updatedAt: node.updatedAt,
    baseSha: node.baseRefOid,
    headSha: node.headRefOid,
    viewerIsAuthor: node.viewerDidAuthor,
  };
}

function summaries(result: SearchResult): InboxSummary[] {
  return result.nodes
    .filter((node): node is InboxNode => 'number' in node)
    .map((node) => ({ ...toSummary(node), ci: ciStatus(commitsRollup(node.commits)) }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Reads PRs through the user's own `gh` login. */
export class GitHub {
  constructor(private readonly run: Runner) {}

  /** Open PRs waiting for the user's review and the user's own open PRs, newest first. */
  async inbox(): Promise<Inbox> {
    const data = await ghGraphql<InboxData>(this.run, INBOX_QUERY, []);
    return { reviewRequested: summaries(data.reviewRequested), mine: summaries(data.mine) };
  }

  /** One PR of `repo` (`owner/name`). */
  async pr(repo: string, number: number): Promise<PrSummary> {
    const data = await prGraphql<PrData>(this.run, repo, number, PR_QUERY);
    const node = data.repository?.pullRequest;
    if (!node) throw new PrNotFoundError(repo, number);
    return toSummary(node);
  }
}
