import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxPr, InboxResponse } from '../../src/shared/api.js';
import { Inbox } from '../../src/web/Inbox.js';

function pr(overrides: Partial<InboxPr>): InboxPr {
  return {
    repo: 'acme/greet',
    number: 1,
    title: 'A change',
    author: 'alice',
    url: 'https://github.com/acme/greet/pull/1',
    additions: 0,
    deletions: 0,
    isDraft: false,
    updatedAt: '2026-10-27T12:00:00Z',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    viewerIsAuthor: false,
    ci: { state: 'none', failing: null },
    tour: { exists: false },
    seenCount: 0,
    drafts: 0,
    ...overrides,
  };
}

function serve(status: number, body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The table under the heading with this name. */
async function tableNamed(name: string): Promise<HTMLElement> {
  return screen.findByRole('table', { name });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Inbox', () => {
  it('renders both lists', async () => {
    const inbox: InboxResponse = {
      reviewRequested: [
        pr({ repo: 'acme/greet', number: 12, title: 'Add greeting', additions: 40, deletions: 3 }),
      ],
      mine: [pr({ repo: 'Acme/Tools', number: 7, title: 'Fix parser', isDraft: true })],
    };
    const fetchMock = serve(200, inbox);
    render(<Inbox />);

    const review = await tableNamed('Waiting for my review');
    const link = within(review).getByRole('link', { name: /#12 Add greeting/ });
    expect(link.getAttribute('href')).toBe('/pr/acme/greet/12');
    expect(within(review).getByText('alice')).toBeTruthy();
    expect(within(review).getByText('+40 / −3')).toBeTruthy();

    const mine = await tableNamed('My open PRs');
    const mineLink = within(mine).getByRole('link', { name: /#7 Fix parser/ });
    expect(mineLink.getAttribute('href')).toBe('/pr/Acme/Tools/7');
    expect(within(mine).getByText('draft')).toBeTruthy();
    expect(within(review).queryByText('draft')).toBeNull();

    expect(fetchMock).toHaveBeenCalledWith('/api/inbox', expect.anything());
  });

  it('shows "no tour yet" when no tour', async () => {
    serve(200, { reviewRequested: [pr({ tour: { exists: false } })], mine: [] });
    render(<Inbox />);

    const review = await tableNamed('Waiting for my review');
    expect(within(review).getByText('no tour yet')).toBeTruthy();
  });

  it('shows "3 flows · author" and "2 of 9 seen"', async () => {
    serve(200, {
      reviewRequested: [],
      mine: [pr({ tour: { exists: true, source: 'author', flows: 3, homes: 9 }, seenCount: 2 })],
    });
    render(<Inbox />);

    const mine = await tableNamed('My open PRs');
    expect(within(mine).getByText('3 flows · author')).toBeTruthy();
    expect(within(mine).getByText('2 of 9 seen')).toBeTruthy();
  });

  it('shows the CI state of each PR', async () => {
    serve(200, {
      reviewRequested: [
        pr({ number: 1, ci: { state: 'success', failing: null } }),
        pr({ number: 2, ci: { state: 'pending', failing: null } }),
        pr({ number: 3, ci: { state: 'none', failing: null } }),
      ],
      mine: [],
    });
    render(<Inbox />);

    const review = await tableNamed('Waiting for my review');
    const ciCells = within(review)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[2]!.textContent);
    expect(ciCells).toEqual(['✓ passing', '● running', '—']);
    expect(within(review).getByRole('columnheader', { name: 'CI' })).toBeTruthy();
  });

  it('a failing CI links to the failing check in a new tab', async () => {
    serve(200, {
      reviewRequested: [
        pr({ ci: { state: 'failure', failing: { name: 'test', url: 'https://ci.example/1' } } }),
      ],
      mine: [],
    });
    render(<Inbox />);

    const review = await tableNamed('Waiting for my review');
    const link = within(review).getByRole('link', { name: /✗ failing/ });
    expect(link.getAttribute('href')).toBe('https://ci.example/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(link.getAttribute('title')).toContain('test');
  });

  it('a failing check without a URL is not a link', async () => {
    serve(200, {
      reviewRequested: [pr({ ci: { state: 'failure', failing: { name: 'lint', url: '' } } })],
      mine: [],
    });
    render(<Inbox />);

    const review = await tableNamed('Waiting for my review');
    expect(within(review).getByText(/✗ failing/)).toBeTruthy();
    expect(within(review).queryByRole('link', { name: /failing/ })).toBeNull();
    expect(within(review).getByText(/lint/)).toBeTruthy();
  });

  it('shows the number of drafts next to the progress', async () => {
    serve(200, {
      reviewRequested: [
        pr({
          number: 1,
          tour: { exists: true, source: 'author', flows: 1, homes: 4 },
          seenCount: 1,
          drafts: 2,
        }),
        pr({ number: 2, tour: { exists: true, source: 'author', flows: 1, homes: 4 } }),
      ],
      mine: [],
    });
    render(<Inbox />);

    const review = await tableNamed('Waiting for my review');
    const [first, second] = within(review).getAllByRole('row').slice(1);
    expect(within(first!).getByText('2 drafts')).toBeTruthy();
    expect(within(second!).queryByText(/draft/)).toBeNull();
  });

  it('shows the server error message when the inbox fails to load', async () => {
    serve(502, { error: 'gh: not logged in to github.com' });
    render(<Inbox />);

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('gh: not logged in to github.com'),
    );
    expect(screen.queryByRole('table')).toBeNull();
  });
});
