import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CommentTarget } from '../../src/shared/review.js';
import { Composer } from '../../src/web/Composer.js';

// The text field for a new comment, a reply, or an edit of a pending draft.

const lineTarget: CommentTarget = { placement: 'line', side: 'new', startLine: 4, endLine: 5 };

function fileTarget(startLine: number, endLine: number): CommentTarget {
  return { placement: 'file', side: 'new', startLine, endLine, quote: 'x' };
}

type Options = Partial<Parameters<typeof Composer>[0]>;

function renderComposer(options: Options = {}) {
  const onSubmit = options.onSubmit ?? vi.fn(() => Promise.resolve());
  const onCancel = options.onCancel ?? vi.fn();
  render(
    <Composer
      target={lineTarget}
      path="src/loan.ts"
      suggestFrom={null}
      submitLabel="Add comment"
      {...options}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
  const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
  const submit = screen.getByRole('button', { name: options.submitLabel ?? 'Add comment' });
  return { textarea, submit, onSubmit, onCancel };
}

function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

describe('Composer', () => {
  it('focuses the text field and starts from the initial text', () => {
    const { textarea } = renderComposer({ initial: 'Earlier text' });
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('Earlier text');
  });

  it('submit is disabled while the body is blank', () => {
    const { textarea, submit } = renderComposer();
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    type(textarea, '   \n ');
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    type(textarea, 'Why?');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('the submit button posts the typed text and mentions Ctrl/Cmd+Enter', () => {
    const { textarea, submit, onSubmit } = renderComposer();
    expect(submit.getAttribute('title')).toBe('Add comment (Ctrl/Cmd+Enter)');
    type(textarea, 'Why?');
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('Why?');
  });

  it('Ctrl+Enter and Cmd+Enter submit; plain Enter does not', async () => {
    const { textarea, onSubmit } = renderComposer();
    type(textarea, 'Why?');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {}); // the first submit finishes
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('Ctrl+Enter on a blank body does nothing', () => {
    const { textarea, onSubmit } = renderComposer();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a failed submit keeps the text and shows a short error', async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error('GitHub said no')));
    const { textarea, submit } = renderComposer({ onSubmit });
    type(textarea, 'Keep me');
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toContain('GitHub said no');
    expect(textarea.value).toBe('Keep me');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('Esc on an empty field cancels', () => {
    const { textarea, onCancel } = renderComposer();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Esc with text asks first; a second Esc cancels', () => {
    const { textarea, onCancel } = renderComposer();
    type(textarea, 'Half a thought');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Discard this comment\? Press Esc again or click Discard\./),
    ).toBeTruthy();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the Discard button cancels; typing hides the prompt', () => {
    const { textarea, onCancel } = renderComposer();
    type(textarea, 'Half a thought');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    type(textarea, 'Half a thought, more');
    expect(screen.queryByText(/Discard this comment\?/)).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Esc on unchanged initial text cancels without asking', () => {
    const { textarea, onCancel } = renderComposer({ initial: 'Saved before' });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the Cancel button shows Esc in its tooltip and asks first when there is text', () => {
    const { textarea, onCancel } = renderComposer();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.getAttribute('title')).toBe('Cancel (Esc)');
    type(textarea, 'Something');
    fireEvent.click(cancel);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText(/Discard this comment\?/)).toBeTruthy();
  });

  it('a line target shows no file-level notice', () => {
    renderComposer();
    expect(screen.queryByText(/not in the diff/)).toBeNull();
  });

  it('a single line outside the diff gets the file-level notice', () => {
    renderComposer({ target: fileTarget(12, 12) });
    expect(
      screen.getByText(
        'Line 12 is not in the diff. This will be sent as a file-level comment quoting the line.',
      ),
    ).toBeTruthy();
  });

  it('a range outside the diff gets the plural notice', () => {
    renderComposer({ target: fileTarget(12, 15) });
    expect(
      screen.getByText(
        'Lines 12–15 are not in the diff. This will be sent as a file-level comment quoting the lines.',
      ),
    ).toBeTruthy();
  });

  it('"Suggest change" shows only for a line target with lines to suggest from', () => {
    renderComposer({ suggestFrom: null });
    expect(screen.queryByRole('button', { name: 'Suggest change' })).toBeNull();
    cleanupAndRender({ target: fileTarget(4, 5), suggestFrom: ['a', 'b'] });
    expect(screen.queryByRole('button', { name: 'Suggest change' })).toBeNull();
    cleanupAndRender({ suggestFrom: ['a', 'b'] });
    expect(screen.getByRole('button', { name: 'Suggest change' })).toBeTruthy();
  });

  it('"Suggest change" inserts a suggestion block at the cursor', () => {
    const { textarea } = renderComposer({ suggestFrom: ['const a = 1;', 'const b = 2;'] });
    type(textarea, 'Before after');
    textarea.setSelectionRange(7, 7);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest change' }));
    expect(textarea.value).toBe('Before ```suggestion\nconst a = 1;\nconst b = 2;\n```after');
  });

  it('the text field is labeled with the file', () => {
    const { textarea } = renderComposer();
    expect(textarea.getAttribute('aria-label')).toBe('Comment on src/loan.ts');
  });

  it('a reply composer (no target) shows no notice and no suggestion button', () => {
    renderComposer({ target: null, suggestFrom: ['a'] });
    expect(screen.queryByText(/not in the diff/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Suggest change' })).toBeNull();
  });
});

function cleanupAndRender(options: Options) {
  cleanup();
  renderComposer(options);
}
