import { Inbox } from './Inbox.js';

/** Where the browser is, from `location.pathname`. Links reload the page; there is no client router. */
export type Route =
  { page: 'inbox' } | { page: 'tour'; repo: string; pr: number } | { page: 'not-found' };

export function parseRoute(pathname: string): Route {
  if (pathname === '/') return { page: 'inbox' };
  const match = /^\/pr\/([^/]+)\/([^/]+)\/([1-9]\d*)\/?$/.exec(pathname);
  if (match) {
    const [, owner, name, pr] = match;
    return { page: 'tour', repo: `${owner}/${name}`, pr: Number(pr) };
  }
  return { page: 'not-found' };
}

export function App() {
  const route = parseRoute(window.location.pathname);
  switch (route.page) {
    case 'inbox':
      return <Inbox />;
    case 'tour':
      // The tour view comes in Task 12 (TourView).
      return (
        <main className="page">
          <p>
            <a href="/">← Inbox</a>
          </p>
          <h1 className="page-title">
            {route.repo}#{route.pr}
          </h1>
        </main>
      );
    case 'not-found':
      return (
        <main className="page">
          <h1 className="page-title">Page not found</h1>
          <p>
            <a href="/">Go to the inbox</a>
          </p>
        </main>
      );
  }
}
