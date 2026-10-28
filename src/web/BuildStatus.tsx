import type { Build } from './useTourBuild.js';

/** Progress of a tour build: its log while it runs, the error and "Try again" when it failed. */
export function BuildStatus({ build, onRetry }: { build: Build; onRetry: () => void }) {
  if (build.state === 'idle') return null;
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
