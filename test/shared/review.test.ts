import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/shared/diff.js';
import {
  commentTarget,
  fileCommentBody,
  isOlderDraft,
  NewDraftSchema,
  type Draft,
} from '../../src/shared/review.js';

// Two hunks. Hunk 1: new 3..6 (old 3..5), line 5 deleted, lines 5-6 added.
// Hunk 2: new 21..23 (old 20..22).
const file: FileDiff = {
  path: 'src/a.ts',
  oldPath: 'src/a.ts',
  status: 'modified',
  binary: false,
  hunks: [
    {
      oldStart: 3,
      oldLines: 3,
      newStart: 3,
      newLines: 4,
      lines: [
        { kind: 'ctx', oldNo: 3, newNo: 3, text: 'line 3' },
        { kind: 'ctx', oldNo: 4, newNo: 4, text: 'line 4' },
        { kind: 'del', oldNo: 5, text: 'old line 5' },
        { kind: 'add', newNo: 5, text: 'new line 5' },
        { kind: 'add', newNo: 6, text: 'new line 6' },
      ],
    },
    {
      oldStart: 20,
      oldLines: 3,
      newStart: 21,
      newLines: 3,
      lines: [
        { kind: 'ctx', oldNo: 20, newNo: 21, text: 'line 21' },
        { kind: 'ctx', oldNo: 21, newNo: 22, text: 'line 22' },
        { kind: 'ctx', oldNo: 22, newNo: 23, text: 'line 23' },
      ],
    },
  ],
};

const lineText = (n: number) => `text ${n}`;

describe('commentTarget', () => {
  it('line inside a hunk → line placement', () => {
    expect(commentTarget(file, 'new', 4, 4, lineText)).toEqual({
      placement: 'line',
      side: 'new',
      startLine: 4,
      endLine: 4,
    });
  });

  it('range inside one hunk → line placement', () => {
    expect(commentTarget(file, 'new', 3, 6, lineText)).toEqual({
      placement: 'line',
      side: 'new',
      startLine: 3,
      endLine: 6,
    });
  });

  it('line outside every hunk → file placement with quote', () => {
    expect(commentTarget(file, 'new', 10, 11, lineText)).toEqual({
      placement: 'file',
      side: 'new',
      startLine: 10,
      endLine: 11,
      quote: 'text 10\ntext 11',
    });
  });

  it('range crossing two hunks → file placement', () => {
    expect(commentTarget(file, 'new', 6, 21, lineText).placement).toBe('file');
  });

  it('old side uses old line numbers', () => {
    expect(commentTarget(file, 'old', 5, 5, lineText)).toEqual({
      placement: 'line',
      side: 'old',
      startLine: 5,
      endLine: 5,
    });
    // Old line 6 does not exist in any hunk (new line 6 does).
    expect(commentTarget(file, 'old', 6, 6, lineText).placement).toBe('file');
  });

  it('quote is cut at 10 lines with …', () => {
    const target = commentTarget(file, 'new', 30, 45, lineText);
    const expected = [...Array.from({ length: 10 }, (_, i) => `text ${30 + i}`), '…'].join('\n');
    expect(target).toEqual({
      placement: 'file',
      side: 'new',
      startLine: 30,
      endLine: 45,
      quote: expected,
    });
  });
});

describe('fileCommentBody', () => {
  it('formats single line, range, and old side', () => {
    expect(fileCommentBody('src/a.ts', 'new', 10, 10, 'const x = 1;', 'Why?')).toBe(
      '**`src/a.ts` line 10** (not in the diff)\n> const x = 1;\n\nWhy?',
    );
    expect(fileCommentBody('src/a.ts', 'new', 10, 12, 'a\nb\nc', 'Why?')).toBe(
      '**`src/a.ts` line 10–12** (not in the diff)\n> a\n> b\n> c\n\nWhy?',
    );
    expect(fileCommentBody('src/a.ts', 'old', 7, 8, 'a\nb', 'Gone?')).toBe(
      '**`src/a.ts` old: line 7–8** (not in the diff)\n> a\n> b\n\nGone?',
    );
  });
});

describe('NewDraftSchema', () => {
  const comment = {
    kind: 'comment',
    path: 'src/a.ts',
    side: 'new',
    startLine: 3,
    endLine: 4,
    headSha: 'h1',
    body: 'Nice',
  };

  it('a comment needs the head it was made on', () => {
    expect(NewDraftSchema.safeParse({ ...comment, headSha: undefined }).success).toBe(false);
    expect(NewDraftSchema.safeParse({ ...comment, headSha: '' }).success).toBe(false);
  });

  it('rejects endLine < startLine and empty body', () => {
    expect(NewDraftSchema.safeParse(comment).success).toBe(true);
    expect(NewDraftSchema.safeParse({ ...comment, startLine: 5, endLine: 4 }).success).toBe(false);
    expect(NewDraftSchema.safeParse({ ...comment, body: '' }).success).toBe(false);
    expect(NewDraftSchema.safeParse({ kind: 'reply', threadId: 't1', body: '' }).success).toBe(
      false,
    );
  });
});

describe('isOlderDraft', () => {
  const comment: Draft = {
    id: 1,
    kind: 'comment',
    path: 'src/a.ts',
    side: 'new',
    startLine: 3,
    endLine: 3,
    placement: 'line',
    quote: 'line 3',
    headSha: 'aaa',
    body: 'x',
    createdAt: '2026-10-28T00:00:00Z',
  };
  const reply: Draft = {
    id: 2,
    kind: 'reply',
    threadId: 't1',
    body: 'y',
    createdAt: '2026-10-28T00:00:00Z',
  };

  it('comment on another head → true; same head → false; reply → false', () => {
    expect(isOlderDraft(comment, 'bbb')).toBe(true);
    expect(isOlderDraft(comment, 'aaa')).toBe(false);
    expect(isOlderDraft(reply, 'bbb')).toBe(false);
  });
});
