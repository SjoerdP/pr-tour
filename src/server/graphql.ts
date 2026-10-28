// GitHub GraphQL through `gh api graphql`, and the errors shared by every PR query.

import { CommandError, runOk, type Runner } from './exec.js';

const REPO = /^([\w.-]+)\/([\w.-]+)$/;
/** What GitHub says when the repo or PR does not exist (or the user cannot see it). */
const NOT_RESOLVED = /Could not resolve to a (Repository|PullRequest)/;

/** A repo argument that is not `owner/name`. */
export class InvalidRepoError extends Error {
  constructor(repo: string) {
    super(`repo must be owner/name, got "${repo}"`);
    this.name = 'InvalidRepoError';
  }
}

/** The PR (or its repo) does not exist, or the user's gh login cannot see it. */
export class PrNotFoundError extends Error {
  constructor(repo: string, number: number) {
    super(`pull request ${repo}#${number} not found`);
    this.name = 'PrNotFoundError';
  }
}

/** GitHub answered with GraphQL errors and no data. `message` is the first error's message. */
export class GraphqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphqlError';
  }
}

type GraphqlResponse<T> = { data?: T | null; errors?: { message: string }[] };

/** Run a GraphQL query with variables as `gh api` field flags; values never go into the query text. */
export async function ghGraphql<T>(run: Runner, query: string, fields: string[]): Promise<T> {
  const { stdout } = await runOk(run, 'gh', ['api', 'graphql', '-f', `query=${query}`, ...fields]);
  const response = JSON.parse(stdout) as GraphqlResponse<T>;
  const first = response.errors?.[0];
  if (response.data == null && first) throw new GraphqlError(first.message);
  return response.data as T;
}

/**
 * Run a query that takes `$owner`, `$name` and `$number` for a PR of `repo` (`owner/name`).
 * `fields` adds more variables. A repo or PR GitHub cannot resolve throws `PrNotFoundError`.
 */
export async function prGraphql<T>(
  run: Runner,
  repo: string,
  number: number,
  query: string,
  fields: string[] = [],
): Promise<T> {
  const match = REPO.exec(repo);
  if (!match) throw new InvalidRepoError(repo);
  const [, owner = '', name = ''] = match;
  try {
    // `-f` passes strings as-is; `-F` would read a value starting with "@" as a file.
    return await ghGraphql<T>(run, query, [
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${number}`,
      ...fields,
    ]);
  } catch (err) {
    const notResolved =
      (err instanceof CommandError && NOT_RESOLVED.test(err.result.stderr)) ||
      (err instanceof GraphqlError && NOT_RESOLVED.test(err.message));
    if (notResolved) throw new PrNotFoundError(repo, number);
    throw err;
  }
}
