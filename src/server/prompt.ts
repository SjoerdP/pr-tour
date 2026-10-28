import type { PrSummary } from '../shared/api.js';

/** The prompt that asks `claude -p` for a tour body as JSON. */
export function tourPrompt(args: {
  diffPath: string;
  pr: PrSummary;
  jsonSchema: object;
  retryError?: string;
}): string {
  const { diffPath, pr, jsonSchema, retryError } = args;
  const parts = [
    `You are writing a guided review tour of pull request ${pr.repo}#${pr.number}: "${pr.title}" by ${pr.author}.`,
    '',
    '## Inputs',
    `- The PR diff (from the merge base to head) is in the file ${diffPath}. Read it with the Read tool.`,
    `- The current working directory is the repository checked out at the PR head (${pr.headSha}). Use Read, Grep and Glob to look at code around the change.`,
    '',
    '## Output',
    'Output only one JSON object that matches the JSON Schema below. No prose before or after it.',
    'Do not set any "id" fields; they are assigned later.',
    '',
    '## How to build the tour',
    '1. summary: two or three sentences on what the PR does and why.',
    '2. foundations first: migrations, models, config and dependencies that the rest of the change builds on.',
    '   For a migration, fill "schemaAfter" (the affected tables after the migration) and "deployCompat"',
    '   (can the old code run against the new schema during a deploy? ok plus a short note).',
    '3. flows: each flow starts at an entry point (HTTP route, job, event handler, CLI command) and follows',
    '   the code in the order it runs. Include unchanged steps on the path ("changed": false) when they',
    '   are needed to understand the changed ones.',
    '   For every step fill "sideEffects" (DB writes, events, external calls), "tests" (tests that cover it)',
    '   and "calls" (where the functions this step calls next are defined: symbol, file, line).',
    '4. other: every remaining change goes into a group by kind: refactor, tests, infra, docs, generated.',
    '',
    '## Homes: every changed line gets exactly one home',
    '- Each foundation, step and other item lists the changed lines it explains in "homes".',
    '- Every added and deleted line in the diff must be in exactly one home: not zero, not two.',
    '- Added lines: side "new" with line numbers in the head version of the file.',
    '- Deleted lines: side "old" with line numbers in the base version of the file.',
    '- Binary files and files without line changes (pure renames, mode changes, empty files): {"file": <path>, "whole": true}.',
    '- An unchanged step has "homes": [].',
    '',
    '## Risk',
    'Use "read-closely" (and say why in "riskReason") for money math, auth and permissions, database writes,',
    'external calls, concurrency and migrations. Use "skim" for everything else.',
    '',
    '## JSON Schema',
    '```json',
    JSON.stringify(jsonSchema, null, 2),
    '```',
  ];
  if (retryError !== undefined) {
    parts.push(
      '',
      '## Your previous answer was rejected',
      'Fix this error and output the whole JSON object again:',
      '```',
      retryError,
      '```',
    );
  }
  return parts.join('\n');
}
