// Review wire types (threads, drafts, CI) and where a comment can go on GitHub.

import { z } from 'zod';
import type { FileDiff } from './diff.js';

export type DiffSide = 'new' | 'old';

export type ThreadComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string;
};

/** A review thread on the PR. `side`/`line` null means a file-level thread. */
export type ReviewThread = {
  id: string;
  path: string;
  side: DiffSide | null;
  line: number | null;
  startLine: number | null;
  outdated: boolean;
  resolved: boolean;
  comments: ThreadComment[];
};

/**
 * A new comment not yet sent to GitHub. `quote` is always set (the server computes it at
 * creation); `headSha` is the tour head it was made on.
 */
export type DraftComment = {
  id: number;
  kind: 'comment';
  path: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  placement: 'line' | 'file';
  quote: string;
  headSha: string;
  body: string;
  createdAt: string;
};

/** A reply to an existing thread, not yet sent to GitHub. */
export type DraftReply = {
  id: number;
  kind: 'reply';
  threadId: string;
  body: string;
  createdAt: string;
};

export type Draft = DraftComment | DraftReply;

/** What the client sends; the server adds placement, quote and headSha. */
export type NewDraft =
  | Omit<DraftComment, 'id' | 'createdAt' | 'placement' | 'quote' | 'headSha'>
  | Omit<DraftReply, 'id' | 'createdAt'>;

/** What the store saves: a comment with placement, quote and headSha filled in, or a reply. */
export type StoredNewDraft =
  Omit<DraftComment, 'id' | 'createdAt'> | Omit<DraftReply, 'id' | 'createdAt'>;

/** True for a comment draft made on another head than the tour's (an "older version"). */
export function isOlderDraft(d: Draft, headSha: string): boolean {
  return d.kind === 'comment' && d.headSha !== headSha;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export type CiStatus = {
  state: 'success' | 'failure' | 'pending' | 'none';
  failing: { name: string; url: string } | null;
};

export type ReviewResponse = {
  viewerIsAuthor: boolean;
  /** Head of the current tour; null without a tour. */
  headSha: string | null;
  threads: ReviewThread[];
  drafts: Draft[];
  ci: CiStatus;
};

const line = z.number().int().min(1);
const body = z.string().min(1);

export const NewDraftSchema: z.ZodType<NewDraft> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('comment'),
      path: z.string().min(1),
      side: z.enum(['new', 'old']),
      startLine: line,
      endLine: line,
      body,
    })
    .refine((d) => d.endLine >= d.startLine, { message: 'endLine must not be before startLine' }),
  z.object({ kind: z.literal('reply'), threadId: z.string().min(1), body }),
]);

export const SubmitBodySchema = z.object({
  event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
  body: z.string().max(65536),
});

export const DraftPatchSchema = z.object({ body });

export type SubmitBody = z.infer<typeof SubmitBodySchema>;
export type DraftPatch = z.infer<typeof DraftPatchSchema>;

export type CommentTarget =
  | { placement: 'line'; side: DiffSide; startLine: number; endLine: number }
  | { placement: 'file'; quote: string };

const MAX_QUOTE_LINES = 10;

/**
 * Where a comment on `startLine..endLine` of `side` can go. GitHub only takes line comments
 * on lines of one hunk; anything else becomes a file-level comment that quotes the code.
 */
export function commentTarget(
  file: FileDiff,
  side: DiffSide,
  startLine: number,
  endLine: number,
  lineText: (n: number) => string,
): CommentTarget {
  const inOneHunk = file.hunks.some((hunk) => {
    const numbers = new Set(hunk.lines.map((l) => (side === 'new' ? l.newNo : l.oldNo)));
    for (let n = startLine; n <= endLine; n++) if (!numbers.has(n)) return false;
    return true;
  });
  if (inOneHunk) return { placement: 'line', side, startLine, endLine };

  const quoted: string[] = [];
  const last = Math.min(endLine, startLine + MAX_QUOTE_LINES - 1);
  for (let n = startLine; n <= last; n++) quoted.push(lineText(n));
  if (endLine > last) quoted.push('…');
  return { placement: 'file', quote: quoted.join('\n') };
}

/** The body of a file-level comment: line reference, quoted code, then the reviewer's text. */
export function fileCommentBody(
  path: string,
  side: DiffSide,
  startLine: number,
  endLine: number,
  quote: string,
  body: string,
): string {
  const lines = endLine !== startLine ? `${startLine}–${endLine}` : `${startLine}`;
  const prefix = side === 'old' ? 'old: ' : '';
  const quoted = quote
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return `**\`${path}\` ${prefix}line ${lines}** (not in the diff)\n${quoted}\n\n${body}`;
}
