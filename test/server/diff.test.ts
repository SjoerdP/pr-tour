import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { changedLines, parseDiff, type FileDiff } from '../../src/server/diff.js';

function fixture(name: string): FileDiff[] {
  return parseDiff(readFileSync(new URL(`../fixtures/${name}.diff`, import.meta.url), 'utf8'));
}

describe('parseDiff', () => {
  it('modified: line numbers', () => {
    const files = fixture('modified');
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toMatchObject({
      path: 'greet.js',
      oldPath: 'greet.js',
      status: 'modified',
      binary: false,
    });
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 6, newStart: 1, newLines: 7 });
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'export function greet(name) {' },
      { kind: 'del', oldNo: 2, text: '  const prefix = "Hello";' },
      { kind: 'del', oldNo: 3, text: '  const sep = ", ";' },
      { kind: 'add', newNo: 2, text: '  const greeting = "Hi";' },
      { kind: 'add', newNo: 3, text: '  const separator = ": ";' },
      { kind: 'add', newNo: 4, text: '  const suffix = "!";' },
      { kind: 'ctx', oldNo: 4, newNo: 5, text: '  return prefix + sep + name;' },
      { kind: 'ctx', oldNo: 5, newNo: 6, text: '}' },
      { kind: 'ctx', oldNo: 6, newNo: 7, text: '' },
    ]);
    expect(changedLines(files)).toEqual([
      { file: 'greet.js', side: 'old', line: 2 },
      { file: 'greet.js', side: 'old', line: 3 },
      { file: 'greet.js', side: 'new', line: 2 },
      { file: 'greet.js', side: 'new', line: 3 },
      { file: 'greet.js', side: 'new', line: 4 },
    ]);
  });

  it('renamed: oldPath and path differ', () => {
    const files = fixture('renamed');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'settings.txt',
      oldPath: 'config.txt',
      status: 'renamed',
      binary: false,
    });
    expect(changedLines(files)).toEqual([
      { file: 'config.txt', side: 'old', line: 5 },
      { file: 'settings.txt', side: 'new', line: 5 },
    ]);
  });

  it('deleted: status deleted, all changed lines are old', () => {
    const files = fixture('deleted');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'legacy.js', oldPath: 'legacy.js', status: 'deleted' });
    expect(changedLines(files)).toEqual([
      { file: 'legacy.js', side: 'old', line: 1 },
      { file: 'legacy.js', side: 'old', line: 2 },
    ]);
  });

  it('added: status added, all changed lines are new', () => {
    const files = fixture('added');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'math.js', status: 'added' });
    expect(changedLines(files)).toEqual([
      { file: 'math.js', side: 'new', line: 1 },
      { file: 'math.js', side: 'new', line: 2 },
      { file: 'math.js', side: 'new', line: 3 },
    ]);
  });

  it('binary: binary true, no hunks', () => {
    const files = fixture('binary');
    expect(files).toEqual([
      { path: 'logo.png', oldPath: 'logo.png', status: 'modified', binary: true, hunks: [] },
    ]);
    expect(changedLines(files)).toEqual([{ file: 'logo.png', side: 'new', line: 0 }]);
  });

  it('no newline at end of file: the marker is not a line', () => {
    const files = fixture('no-newline');
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'name = "app"' },
      { kind: 'del', oldNo: 2, text: 'version = "1.0"' },
      { kind: 'add', newNo: 2, text: 'version = "1.1"' },
    ]);
    expect(changedLines(files)).toEqual([
      { file: 'app.toml', side: 'old', line: 2 },
      { file: 'app.toml', side: 'new', line: 2 },
    ]);
  });

  it('empty diff returns []', () => {
    expect(parseDiff('')).toEqual([]);
  });
});
