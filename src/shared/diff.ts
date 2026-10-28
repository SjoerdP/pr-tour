// The diff model. The server parses `git diff` into these; the web renders them.

export type DiffLine = {
  kind: 'add' | 'del' | 'ctx';
  oldNo?: number;
  newNo?: number;
  text: string;
};

export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type FileDiff = {
  /** New path. For added and deleted files this equals `oldPath`. */
  path: string;
  oldPath: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  hunks: Hunk[];
};
