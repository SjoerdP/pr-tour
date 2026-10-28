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
    tour: { exists: false },
    seenCount: 0,
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
