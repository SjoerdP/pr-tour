import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Draft, DraftComment, ReviewThread } from '../../src/shared/review.js';
import type { Tour } from '../../src/shared/tour.js';
import { ReviewPanel } from '../../src/web/ReviewPanel.js';
import type { ReviewState } from '../../src/web/useReview.js';
import { fakeReview } from './review-fake.js';
import { tour as baseTour } from './tour-fixture.js';

// The review panel: pending drafts, unresolved threads, the summary, the event and Submit.

const HEAD = 'b'.repeat(40);

function comment(overrides: Partial<DraftComment> = {}): Draft {
  return {
    id: 7,
    kind: 'comment',
    path: 'src/a.ts',
    side: 'new',
    startLine: 5,
    endLine: 5,
    placement: 'line',
    quote: 'x',
    headSha: HEAD,
    body: 'Rename this',
    createdAt: '2026-10-28T10:00:00Z',
    ...overrides,
  };
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'T1',
    path: 'src/a.ts',
    side: 'new',
    line: 3,
    startLine: null,
    outdated: false,
    resolved: false,
    comments: [
      {
        id: 'c1',
        author: 'alice',
        body: 'Why this change?',
        createdAt: '2026-10-28T09:00:00Z',
        url: 'https://github.com/acme/loans/pull/42#discussion_c1',
      },
    ],
    ...overrides,
  };
}

/** F1.S3 is read closely, so the reminder lists it first. */
const tour: Tour = {
  ...baseTour,
  flows: baseTour.flows.map((f) => ({
    ...f,
    steps: f.steps.map((s) => (s.id === 'F1.S3' ? { ...s, risk: 'read-closely' as const } : s)),
  })),
};

function renderPanel(
  review: ReviewState = fakeReview(),
  options: { isSeen?: (id: string) => boolean } = {},
) {
  const props = {
    review,
    tour,
    isSeen: options.isSeen ?? (() => true),
    onOpenHome: vi.fn(),
    onJump: vi.fn(),
    onClose: vi.fn(),
  };
  render(<ReviewPanel {...props} />);
  return props;
}

const panel = () => screen.getByRole('region', { name: 'Review' });
const submitButton = () =>
  within(panel()).getByRole('button', { name: /^(Submit review|Approve anyway)$/ });

describe('ReviewPanel: drafts and threads', () => {
  it('lists pending drafts with their place and unresolved threads', () => {
    renderPanel(
      fakeReview({
        threads: [thread(), thread({ id: 'T2', resolved: true, path: 'src/b.ts' })],
        drafts: [
          comment(),
          comment({ id: 8, startLine: 2, endLine: 4, body: 'Range' }),
          {
            id: 9,
            kind: 'reply',
            threadId: 'T1',
            body: 'Agreed',
            createdAt: '2026-10-28T10:00:00Z',
          },
        ],
      }),
    );

    const drafts = screen.getByRole('list', { name: 'Pending comments' });
    const items = within(drafts).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('src/a.ts:5'),
      expect.stringContaining('src/a.ts:2–4'),
      expect.stringContaining('reply in src/a.ts'),
    ]);
    expect(items[0]!.textContent).toContain('Rename this');

    const threads = screen.getByRole('list', { name: 'Unresolved threads' });
    expect(within(threads).getAllByRole('listitem')).toHaveLength(1);
    expect(within(threads).getByText(/src\/a\.ts:3/)).toBeTruthy();
    expect(within(threads).getByText(/Why this change\?/)).toBeTruthy();
  });

  it('a draft in a home opens that home', () => {
    const props = renderPanel(fakeReview({ drafts: [comment()] }));
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts:5' }));
    expect(props.onOpenHome).toHaveBeenCalledWith('F1.S1');
    expect(props.onJump).not.toHaveBeenCalled();
  });

  it('a draft no home owns opens its file at the line', () => {
    const props = renderPanel(fakeReview({ drafts: [comment({ startLine: 40, endLine: 41 })] }));
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts:40–41' }));
    expect(props.onJump).toHaveBeenCalledWith('src/a.ts', 41);
    expect(props.onOpenHome).not.toHaveBeenCalled();
  });

  it('a thread jumps to its place; a reply jumps to its thread', () => {
    const props = renderPanel(
      fakeReview({
        threads: [thread({ path: 'lib/x.ts', line: 12 })],
        drafts: [
          {
            id: 9,
            kind: 'reply',
            threadId: 'T1',
            body: 'Agreed',
            createdAt: '2026-10-28T10:00:00Z',
          },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'lib/x.ts:12' }));
    expect(props.onJump).toHaveBeenCalledWith('lib/x.ts', 12);
    fireEvent.click(screen.getByRole('button', { name: 'reply in lib/x.ts' }));
    expect(props.onJump).toHaveBeenCalledTimes(2);
  });

  it('a draft can be deleted', async () => {
    const review = fakeReview({ drafts: [comment()] });
    renderPanel(review);
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft on src/a.ts:5' }));
    await vi.waitFor(() => expect(review.remove).toHaveBeenCalledWith(7));
  });

  it('a failed delete shows the error', async () => {
    const review = fakeReview({ drafts: [comment()] });
    vi.mocked(review.remove).mockRejectedValue(new Error('disk full'));
    renderPanel(review);
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft on src/a.ts:5' }));
    expect((await screen.findByRole('alert')).textContent).toContain('disk full');
  });

  it('an older-version draft is labeled and says how it will be sent', () => {
    renderPanel(fakeReview({ drafts: [comment({ headSha: 'c'.repeat(40) })] }));
    const item = within(screen.getByRole('list', { name: 'Pending comments' })).getByRole(
      'listitem',
    );
    expect(within(item).getByText('older version')).toBeTruthy();
    expect(
      within(item).getByText(
        'Made on an older version of this PR. It will be sent as a file-level comment that quotes the lines.',
      ),
    ).toBeTruthy();
  });

  it('says so when nothing is pending', () => {
    renderPanel();
    expect(within(panel()).getByText('No pending comments.')).toBeTruthy();
  });

  it('a failed refresh is a quiet note, not a block', () => {
    renderPanel({ ...fakeReview({ drafts: [comment()] }), error: 'timeout' });
    expect(within(panel()).getByText("Couldn't refresh comments")).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Pending comments' })).toBeTruthy();
  });
});

describe('ReviewPanel: event', () => {
  it('offers Comment, Approve and Request changes; Comment is chosen', () => {
    renderPanel();
    const group = screen.getByRole('radiogroup', { name: 'Review event' });
    const radios = within(group).getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
      'Comment',
      'Approve',
      'Request changes',
    ]);
    expect(radios[0]!.checked).toBe(true);
    expect(radios.some((r) => r.disabled)).toBe(false);
  });

  it('on your own PR only Comment can be chosen, and it says why', () => {
    renderPanel({ ...fakeReview(), viewerIsAuthor: true });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Approve' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Request changes' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Comment' }).disabled).toBe(false);
    expect(screen.getByText("You can't approve your own PR on GitHub.")).toBeTruthy();
  });
});

describe('ReviewPanel: approve reminder', () => {
  it('lists unseen items, read-closely first, and the button says "Approve anyway"', () => {
    const props = renderPanel(fakeReview(), { isSeen: (id) => id === 'f1' || id === 'o1.1' });
    expect(screen.queryByText(/You haven't seen/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    const reminder = screen.getByRole('region', { name: 'Not seen yet' });
    expect(within(reminder).getByText("You haven't seen 2 items")).toBeTruthy();
    const items = within(reminder).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Record the repayment'),
      expect.stringContaining('Parse the request'),
    ]);
    expect(submitButton().textContent).toBe('Approve anyway');

    fireEvent.click(within(items[0]!).getByRole('button', { name: 'Go to it' }));
    expect(props.onOpenHome).toHaveBeenCalledWith('F1.S3');
  });

  it('says "1 item" for one', () => {
    renderPanel(fakeReview(), { isSeen: (id) => id !== 'f1' });
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    expect(screen.getByText("You haven't seen 1 item")).toBeTruthy();
  });

  it('has no reminder when everything was seen', () => {
    renderPanel(fakeReview(), { isSeen: () => true });
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    expect(screen.queryByText(/You haven't seen/)).toBeNull();
    expect(submitButton().textContent).toBe('Submit review');
  });
});

describe('ReviewPanel: submit', () => {
  it('sends the event and the summary', async () => {
    const review = fakeReview({ drafts: [comment()] });
    renderPanel(review);
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Needs a test.' },
    });
    fireEvent.click(submitButton());
    await vi.waitFor(() =>
      expect(review.submit).toHaveBeenCalledWith('REQUEST_CHANGES', 'Needs a test.'),
    );
  });

  it('on success says "Review sent" with a link; following it closes the panel', async () => {
    const review = fakeReview({ drafts: [comment()] });
    vi.mocked(review.submit).mockResolvedValue({ url: 'https://github.com/r/1' });
    const props = renderPanel(review);
    fireEvent.click(submitButton());

    const link = await screen.findByRole('link', { name: /view it on GitHub/i });
    expect(screen.getByText(/Review sent/)).toBeTruthy();
    expect(link.getAttribute('href')).toBe('https://github.com/r/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('Close closes the panel', () => {
    const props = renderPanel();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('on failure shows the error and marks the draft GitHub refused', () => {
    renderPanel({
      ...fakeReview({ drafts: [comment(), comment({ id: 8, startLine: 6, endLine: 6 })] }),
      submitError: { message: 'GitHub said no', failedDraftId: 8 },
    });
    expect(screen.getByRole('alert').textContent).toContain('GitHub said no');
    const items = within(screen.getByRole('list', { name: 'Pending comments' })).getAllByRole(
      'listitem',
    );
    expect(items[0]!.classList.contains('failed')).toBe(false);
    expect(items[1]!.classList.contains('failed')).toBe(true);
    expect(within(items[1]!).getByText('Not sent')).toBeTruthy();
  });

  it('Submit is disabled while sending', () => {
    renderPanel({ ...fakeReview({ drafts: [comment()] }), submitting: true });
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('a comment review needs a summary or a pending comment', () => {
    renderPanel();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Looks fine.' },
    });
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
  });
});
