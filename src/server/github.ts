import type { Inbox, PrSummary } from '../shared/api.js';
import { runOk, type Runner } from './exec.js';

export type { Inbox, PrSummary } from '../shared/api.js';

const REPO = /^([\w.-]+)\/([\w.-]+)$/;

const PR_FIELDS = `
  number title url additions deletions isDraft updatedAt baseRefOid headRefOid
  repository { nameWithOwner }
  author { login }
`;

const INBOX_QUERY = `query {
  reviewRequested: search(query: "is:pr is:open review-requested:@me", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  mine: search(query: "is:pr is:open author:@me", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
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
  repository: { nameWithOwner: string };
  /** Null when the author's account was deleted. */
  author: { login: string } | null;
};

/** Search results can hold issues too; the `... on PullRequest` fragment leaves those as `{}`. */
type SearchResult = { nodes: (PrNode | Record<string, never>)[] };

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
  };
}

function summaries(result: SearchResult): PrSummary[] {
  return result.nodes
    .filter((node): node is PrNode => 'number' in node)
    .map(toSummary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Reads PRs through the user's own `gh` login. */
export class GitHub {
  constructor(private readonly run: Runner) {}

  /** Open PRs waiting for the user's review and the user's own open PRs, newest first. */
  async inbox(): Promise<Inbox> {
    const data = await this.graphql<InboxData>(INBOX_QUERY, []);
    return { reviewRequested: summaries(data.reviewRequested), mine: summaries(data.mine) };
  }

  /** One PR of `repo` (`owner/name`). */
  async pr(repo: string, number: number): Promise<PrSummary> {
    const match = REPO.exec(repo);
    if (!match) throw new Error(`repo must be owner/name, got "${repo}"`);
    const [, owner = '', name = ''] = match;
    // `-f` passes strings as-is; `-F` would read a value starting with "@" as a file.
    const data = await this.graphql<PrData>(PR_QUERY, [
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${number}`,
    ]);
    const node = data.repository?.pullRequest;
    if (!node) throw new Error(`pull request ${repo}#${number} not found`);
    return toSummary(node);
  }

  /** Run a GraphQL query with variables as `gh api` field flags; values never go into the query text. */
  private async graphql<T>(query: string, fields: string[]): Promise<T> {
    const { stdout } = await runOk(this.run, 'gh', [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      ...fields,
    ]);
    return (JSON.parse(stdout) as { data: T }).data;
  }
}
