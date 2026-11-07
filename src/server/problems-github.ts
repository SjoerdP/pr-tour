// Possible problems from CI on GitHub: the check runs of the tour's head commit, their line
// annotations, and failed runs.

import type { Level, Problem } from '../shared/problems.js';
import type { Tour } from '../shared/tour.js';
import { lineChanges, type FileDiff } from './diff.js';
import type { Runner } from './exec.js';
import { ghGraphql, GraphqlError, splitRepo } from './graphql.js';

type AnnotationLevel = 'NOTICE' | 'WARNING' | 'FAILURE';

/** A check run as `CHECK_RUNS_QUERY` selects it. */
export type CheckRunNode = {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  summary: string | null;
  text: string | null;
  annotations: {
    nodes: Array<{
      path: string;
      annotationLevel: AnnotationLevel;
      title: string | null;
      message: string;
      location: { start: { line: number }; end: { line: number } };
    }>;
  };
};

// The commit goes in as `$sha`, never into the query text.
// GitHub refuses a query that may return more than 500,000 nodes, counting the nested
// limits multiplied: 20 suites × 50 runs × 50 annotations is 50,000.
const CHECK_RUNS_QUERY = `query($owner: String!, $name: String!, $sha: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $sha) {
      ... on Commit {
        statusCheckRollup { state }
        checkSuites(first: 20) { nodes { checkRuns(first: 50) { nodes {
          name status conclusion detailsUrl summary text
          annotations(first: 50) { nodes {
            path annotationLevel title message
            location { start { line } end { line } }
          } }
        } } } }
      }
    }
  }
}`;

type CheckRunsData = {
  /** Null when GitHub does not know the repo, or the user cannot read it. */
  repository: {
    /** Null when GitHub does not know the commit. */
    object: {
      statusCheckRollup: { state: string } | null;
      checkSuites: { nodes: { checkRuns: { nodes: CheckRunNode[] } }[] };
    } | null;
  } | null;
};

/** CI on GitHub, through the user's own `gh` login. */
export class ProblemsGitHub {
  constructor(private readonly run: Runner) {}

  /**
   * The check runs of commit `sha` in `repo` (`owner/name`), and whether CI is still running.
   * A commit GitHub does not know has no runs; a repo it does not know is an error.
   */
  async checkRuns(repo: string, sha: string): Promise<{ runs: CheckRunNode[]; pending: boolean }> {
    const { owner, name } = splitRepo(repo);
    const data = await ghGraphql<CheckRunsData>(this.run, CHECK_RUNS_QUERY, [
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-f',
      `sha=${sha}`,
    ]);
    // GitHub answers `repository: null` for a repo it does not know or the user cannot read.
    if (!data.repository) throw new GraphqlError(`repository ${repo} not found`);
    const commit = data.repository.object;
    if (!commit) return { runs: [], pending: false };
    const state = commit.statusCheckRollup?.state;
    return {
      runs: commit.checkSuites.nodes.flatMap((suite) => suite.checkRuns.nodes),
      pending: state === 'PENDING' || state === 'EXPECTED',
    };
  }
}

const ANNOTATION_LEVEL: Record<AnnotationLevel, Level> = {
  FAILURE: 'bug',
  WARNING: 'risk',
  NOTICE: 'look',
};

/** Check run conclusions that mean the run failed. */
const FAILED_RUN = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);

/**
 * The possible problems in check runs `runs` of the tour's head commit. An annotation counts
 * only on a line the PR added (`files`); others are dropped. A failed run with no annotation
 * kept is one problem: on a step when it names one of the steps' tests, else PR-wide.
 */
export function ciProblems(runs: CheckRunNode[], files: FileDiff[], tour: Tour): Problem[] {
  const added = new Map<string, string>();
  for (const change of lineChanges(files)) {
    if (change.kind === 'add') added.set(lineId(change.file, change.line), change.text);
  }
  const tests = [
    ...new Set(tour.flows.flatMap((f) => f.steps.flatMap((s) => s.tests)).map((t) => t.name)),
  ];

  const problems: Problem[] = [];
  for (const run of runs) {
    let kept = 0;
    for (const a of run.annotations.nodes) {
      const line = a.location.start.line;
      const lineText = added.get(lineId(a.path, line));
      if (lineText === undefined) continue;
      kept++;
      const [first = '', ...rest] = a.message.split('\n');
      const title = a.title?.trim() || first.trim();
      const why = a.title?.trim() ? a.message.trim() : rest.join('\n').trim();
      problems.push({
        key: `ci|${run.name}|${a.path}|${lineText}|${title}`,
        level: ANNOTATION_LEVEL[a.annotationLevel],
        title,
        ...(why ? { why } : {}),
        sources: [run.name],
        at: { kind: 'line', file: a.path, side: 'new', line },
        ...(run.detailsUrl ? { url: run.detailsUrl } : {}),
      });
    }
    if (kept > 0 || run.conclusion === null || !FAILED_RUN.has(run.conclusion)) continue;

    const output = `${run.summary ?? ''}\n${run.text ?? ''}`;
    const failing = tests.filter((test) => wholeWord(test).test(output));
    const base = {
      level: 'bug' as const,
      sources: ['CI'],
      ...(run.detailsUrl ? { url: run.detailsUrl } : {}),
    };
    if (failing.length === 0) {
      problems.push({
        ...base,
        key: `ci|${tour.headSha}|${run.name}|`,
        title: `CI check "${run.name}" fails`,
        at: { kind: 'pr' },
      });
    }
    for (const test of failing) {
      problems.push({
        ...base,
        key: `ci|${tour.headSha}|${run.name}|${test}`,
        title: `Test ${test} fails in CI`,
        at: { kind: 'step', test },
      });
    }
  }
  return uniqueByKey(problems);
}

function lineId(file: string, line: number): string {
  return `${file}:${line}`;
}

/** Matches `word` with no word character right before or after it. */
function wholeWord(word: string): RegExp {
  return new RegExp(`(?<!\\w)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`);
}

/** `problems` without later ones whose key was seen (e.g. two runs of a matrix with one name). */
function uniqueByKey(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => !seen.has(p.key) && seen.add(p.key));
}
