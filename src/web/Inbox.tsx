import { useEffect, useId, useState } from 'react';
import type { InboxPr, InboxResponse } from '../shared/api.js';
import { getInbox } from './api.js';
import { errorText } from './errors.js';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; inbox: InboxResponse };

/** The start page: PRs waiting for the user's review and the user's own open PRs. */
export function Inbox() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    getInbox().then(
      (inbox) => {
        if (active) setState({ status: 'ready', inbox });
      },
      (err: unknown) => {
        if (active) setState({ status: 'error', message: errorText(err) });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="page">
      <h1 className="page-title">pr-tour</h1>
      {state.status === 'loading' && <p className="muted">Loading your pull requests…</p>}
      {state.status === 'error' && (
        <p className="error" role="alert">
          Could not load the inbox: {state.message}
        </p>
      )}
      {state.status === 'ready' && (
        <>
          <PrTable title="Waiting for my review" prs={state.inbox.reviewRequested} />
          <PrTable title="My open PRs" prs={state.inbox.mine} />
        </>
      )}
    </main>
  );
}

function PrTable({ title, prs }: { title: string; prs: InboxPr[] }) {
  const headingId = useId();
  return (
    <section className="inbox-section">
      <h2 id={headingId}>{title}</h2>
      {prs.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table className="pr-table" aria-labelledby={headingId}>
          <thead>
            <tr>
              <th scope="col">PR</th>
              <th scope="col">Author</th>
              <th scope="col">Size</th>
              <th scope="col">Tour</th>
              <th scope="col">Progress</th>
            </tr>
          </thead>
          <tbody>
            {prs.map((pr) => (
              <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PrRow({ pr }: { pr: InboxPr }) {
  return (
    <tr>
      <td className="pr-cell">
        <span className="repo">{pr.repo}</span>
        <a href={`/pr/${pr.repo}/${pr.number}`}>
          <span className="pr-number">#{pr.number}</span> {pr.title}
        </a>
        {pr.isDraft && <span className="tag">draft</span>}
      </td>
      <td>{pr.author}</td>
      <td className="num">
        <span className="size">{`+${pr.additions} / −${pr.deletions}`}</span>
      </td>
      <td>{tourText(pr)}</td>
      <td className="num">{progressText(pr)}</td>
    </tr>
  );
}

function tourText({ tour }: InboxPr): string {
  if (!tour.exists) return 'no tour yet';
  const flows = tour.flows ?? 0;
  return `${flows} ${flows === 1 ? 'flow' : 'flows'} · ${tour.source ?? 'inferred'}`;
}

function progressText({ tour, seenCount }: InboxPr): string {
  if (!tour.exists) return '—';
  return `${seenCount} of ${tour.homes ?? 0} seen`;
}
