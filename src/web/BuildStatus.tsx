import type { Build } from './useTourBuild.js';

/**
 * Progress of a tour build: its log while it runs, the error and "Try again" when it failed,
 * and "Rebuild" / "Cancel" when replacing the tour needs a yes because the PR has drafts.
 */
export function BuildStatus({
  build,
  onRetry,
  onConfirm,
  onCancel,
}: {
  build: Build;
  onRetry: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (build.state === 'idle') return null;
  if (build.state === 'confirm') {
    const drafts = `${build.drafts} unsent ${build.drafts === 1 ? 'draft' : 'drafts'}`;
    return (
      <div className="build-status build-confirm" role="group" aria-label="Replace the tour">
        <p className="warn">You have {drafts}. Rebuild anyway?</p>
        <div className="build-confirm-actions">
          <button type="button" className="primary" onClick={onConfirm}>
            Rebuild
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (build.state === 'failed') {
    return (
      <div className="build-status">
        <p className="error" role="alert">
          The tour build failed: {build.error}
        </p>
        <button type="button" onClick={onRetry}>
          Try again
        </button>
        <JobLog log={build.log} />
      </div>
    );
  }
  return (
    <div className="build-status" aria-busy="true">
      <p className="muted">Building the tour… this can take a few minutes.</p>
      {build.state === 'running' && build.pollError && (
        <p className="warn" role="status">
          {build.pollError}
        </p>
      )}
      {build.state === 'running' && <JobLog log={build.log} />}
    </div>
  );
}

function JobLog({ log }: { log: string[] }) {
  if (log.length === 0) return null;
  return (
    <pre className="job-log" aria-label="Build log">
      {log.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </pre>
  );
}
