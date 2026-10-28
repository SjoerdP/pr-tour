import { useRef, useState, type KeyboardEvent } from 'react';
import type { CommentTarget } from '../shared/review.js';
import { errorText } from './errors.js';
import { withKey } from './shortcuts.js';

type Props = {
  /** Where the comment goes; null for a reply or a reply edit (no notice, no suggestion). */
  target: CommentTarget | null;
  path: string;
  /** The selected new-side lines, for "Suggest change"; null when there is nothing to suggest. */
  suggestFrom: string[] | null;
  initial?: string;
  submitLabel: string;
  /** May reject; the text then stays and a short error shows. */
  onSubmit: (body: string) => Promise<unknown> | void;
  onCancel: () => void;
};

const SUBMIT_KEY = 'Ctrl/Cmd+Enter';

/**
 * The text field for a comment. Only what the user types is sent. `Esc` cancels, but asks
 * first when there is typed text; `Ctrl/Cmd+Enter` submits. A failed submit keeps the text.
 */
export function Composer({
  target,
  path,
  suggestFrom,
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
}: Props) {
  const [body, setBody] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const blank = body.trim() === '';
  const canSuggest = target?.placement === 'line' && suggestFrom !== null;

  function cancel() {
    // Nothing would be lost: cancel at once. Otherwise ask first, then cancel.
    if (blank || body === initial || confirming) onCancel();
    else setConfirming(true);
  }

  async function submit() {
    if (blank || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      // The key belongs to this field, not to the page's shortcuts.
      event.preventDefault();
      event.stopPropagation();
      cancel();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      void submit();
    }
  }

  function edit(next: string) {
    setBody(next);
    setConfirming(false);
  }

  function suggest() {
    if (!suggestFrom) return;
    const el = field.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const block = '```suggestion\n' + suggestFrom.join('\n') + '\n```';
    edit(body.slice(0, start) + block + body.slice(end));
    const caret = start + block.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="composer">
      {target?.placement === 'file' && <p className="composer-notice">{fileNotice(target)}</p>}
      <textarea
        ref={field}
        className="composer-field"
        aria-label={`Comment on ${path}`}
        rows={4}
        // The composer opens because the user asked to write; the field takes focus.
        autoFocus
        value={body}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {confirming && (
        <p className="composer-confirm" role="status">
          Discard this comment? Press Esc again or click Discard.{' '}
          <button type="button" className="link-button" onClick={onCancel}>
            Discard
          </button>
        </p>
      )}
      {error !== null && (
        <p className="composer-error" role="alert">
          Not saved: {error}
        </p>
      )}
      <div className="composer-actions">
        {canSuggest && (
          <button type="button" onClick={suggest}>
            Suggest change
          </button>
        )}
        <span className="composer-spacer" />
        <button type="button" title={withKey('Cancel', 'Esc')} onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          title={withKey(submitLabel, SUBMIT_KEY)}
          disabled={blank || busy}
          onClick={() => void submit()}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function fileNotice(target: { startLine: number; endLine: number }): string {
  const { startLine, endLine } = target;
  if (startLine === endLine) {
    return `Line ${startLine} is not in the diff. This will be sent as a file-level comment quoting the line.`;
  }
  return `Lines ${startLine}–${endLine} are not in the diff. This will be sent as a file-level comment quoting the lines.`;
}
