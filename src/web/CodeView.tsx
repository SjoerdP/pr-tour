import type { Tour } from '../shared/tour.js';

export type CodeViewProps = {
  repo: string;
  pr: number;
  tour: Tour;
  file: string;
  focus: { start: number; end: number } | null;
  homeId: string;
  onJump: (file: string, line: number) => void;
};

/** Placeholder until the whole-file code view (Task 13) replaces it. */
export function CodeView({ file, focus }: CodeViewProps) {
  return (
    <section className="code-view" aria-label="Code">
      <p className="muted">
        <code>{file}</code>
        {focus && ` lines ${focus.start}–${focus.end}`}
      </p>
    </section>
  );
}
