import parse from 'parse-diff';
import type { DiffLine, FileDiff, Hunk } from '../shared/diff.js';

export type { DiffLine, FileDiff, Hunk } from '../shared/diff.js';

/** The file of `files` at `path`, by its new path or else its old one (a rename). */
export function findFileDiff(files: FileDiff[], path: string): FileDiff | null {
  return files.find((f) => f.path === path) ?? files.find((f) => f.oldPath === path) ?? null;
}

export type ChangedLine = { file: string; side: 'new' | 'old'; line: number };

const DEV_NULL = '/dev/null';

/** Parse `git diff` output into file diffs. */
export function parseDiff(text: string): FileDiff[] {
  const files = parse(text);
  const sections = fileSections(text);
  return files.map((file, i) => {
    const from = file.from && file.from !== DEV_NULL ? file.from : undefined;
    const to = file.to && file.to !== DEV_NULL ? file.to : undefined;
    const path = to ?? from ?? '';
    const oldPath = from ?? path;
    const status: FileDiff['status'] = file.deleted
      ? 'deleted'
      : file.new
        ? 'added'
        : oldPath !== path
          ? 'renamed'
          : 'modified';
    // parse-diff has no binary flag; git says so in the file's header instead.
    const binary = file.chunks.length === 0 && BINARY.test(sections[i] ?? '');
    return { path, oldPath, status, binary, hunks: file.chunks.map(toHunk) };
  });
}

/**
 * A changed line with what changed. `kind` is `add` or `del` with the line's text,
 * or `file` (text `''`) for a file with no hunks; see `changedLines`.
 */
export type LineChange = ChangedLine & { kind: 'add' | 'del' | 'file'; text: string };

/**
 * Every added line (new side) and deleted line (old side), in diff order.
 * A file with no hunks (binary, pure rename, mode-only change, empty added or deleted file)
 * counts as one whole-file line: `{ file: path, side: 'new', line: 0 }`, so it still needs a home.
 */
export function changedLines(files: FileDiff[]): ChangedLine[] {
  return lineChanges(files).map(({ file, side, line }) => ({ file, side, line }));
}

/** `changedLines` with each line's kind and text. The one place that walks the hunks. */
export function lineChanges(files: FileDiff[]): LineChange[] {
  const out: LineChange[] = [];
  for (const file of files) {
    if (file.hunks.length === 0) {
      out.push({ file: file.path, side: 'new', line: 0, kind: 'file', text: '' });
      continue;
    }
    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        if (l.kind === 'add' && l.newNo !== undefined) {
          out.push({ file: file.path, side: 'new', line: l.newNo, kind: 'add', text: l.text });
        } else if (l.kind === 'del' && l.oldNo !== undefined) {
          out.push({ file: file.oldPath, side: 'old', line: l.oldNo, kind: 'del', text: l.text });
        }
      }
    }
  }
  return out;
}

const BINARY = /^(Binary files .* differ|GIT binary patch)$/m;

/** Split raw diff text into one chunk of text per `diff --git` file, in order. */
function fileSections(text: string): string[] {
  return text.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '));
}

function toHunk(chunk: parse.Chunk): Hunk {
  const lines: DiffLine[] = [];
  for (const change of chunk.changes) {
    // parse-diff reports "\ No newline at end of file" as a change; it is not a line.
    if (change.content.startsWith('\\')) continue;
    const text = change.content.slice(1);
    if (change.type === 'add') lines.push({ kind: 'add', newNo: change.ln, text });
    else if (change.type === 'del') lines.push({ kind: 'del', oldNo: change.ln, text });
    else lines.push({ kind: 'ctx', oldNo: change.ln1, newNo: change.ln2, text });
  }
  return {
    oldStart: chunk.oldStart,
    oldLines: chunk.oldLines,
    newStart: chunk.newStart,
    newLines: chunk.newLines,
    lines,
  };
}
