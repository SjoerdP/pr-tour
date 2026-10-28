// What the reviewer was writing, kept while the code view remounts (another step, a followed
// call, a "go to" from the review panel), so it comes back when that file or thread shows again.

import { createContext, useContext } from 'react';
import type { DiffSide } from '../shared/review.js';

/** Lines picked for a comment: from the first one clicked to the last one (shift+)clicked. */
export type Selection = { side: DiffSide; anchor: number; line: number };

/** A new comment being written on a file: its picked lines and the text typed so far. */
export type FileComposer = { selection: Selection; typed: string };

/**
 * Open composers by place: a new comment per file, a reply per thread, an edit per draft.
 * Plain maps, not React state: typing writes here without re-rendering anything. An entry is
 * removed when its composer is sent or cancelled.
 */
export class ComposerMemory {
  /** @param pr The PR (`repo#pr`) this memory belongs to: one memory per PR. */
  constructor(readonly pr: string) {}

  private readonly files = new Map<string, FileComposer>();
  private readonly replies = new Map<string, string>();
  private readonly edits = new Map<number, string>();

  /** `key` names the file on one head (lines picked on one head mean nothing on another). */
  file(key: string): FileComposer | undefined {
    return this.files.get(key);
  }

  setFile(key: string, entry: FileComposer | null): void {
    if (entry) this.files.set(key, entry);
    else this.files.delete(key);
  }

  /** The reply typed in a thread; undefined when no reply is open there. */
  reply(threadId: string): string | undefined {
    return this.replies.get(threadId);
  }

  setReply(threadId: string, text: string | null): void {
    if (text === null) this.replies.delete(threadId);
    else this.replies.set(threadId, text);
  }

  /** The edit typed for a draft ('' for an open edit not typed in yet); undefined when closed. */
  edit(draftId: number): string | undefined {
    return this.edits.get(draftId);
  }

  setEdit(draftId: number, text: string | null): void {
    if (text === null) this.edits.delete(draftId);
    else this.edits.set(draftId, text);
  }
}

/** The PR's composer memory; null outside a tour (the composers then keep nothing). */
export const ComposerMemoryContext = createContext<ComposerMemory | null>(null);

export function useComposerMemory(): ComposerMemory | null {
  return useContext(ComposerMemoryContext);
}
