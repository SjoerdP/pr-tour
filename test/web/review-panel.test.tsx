import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Draft, DraftComment, ReviewThread } from '../../src/shared/review.js';
import type { Tour } from '../../src/shared/tour.js';
import { ReviewPanel, type ReviewDraftText } from '../../src/web/ReviewPanel.js';
import type { ProblemsValue } from '../../src/web/ProblemsContext.js';
import type { ReviewState } from '../../src/web/useReview.js';
import { line, problem, WithProblems } from './problems-fake.js';
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
    bot: false,
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
  options: { isSeen?: (id: string) => boolean; problems?: Partial<ProblemsValue> } = {},
) {
  const props = {
    review,
    tour,
    isSeen: options.isSeen ?? (() => true),
    onOpenHome: vi.fn(),
    onJump: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <WithProblems value={options.problems ?? {}}>
      <Harness {...props} />
    </WithProblems>,
  );
  return props;
}

/** The panel with its summary and event kept the way the top bar keeps them. */
function Harness(props: Omit<Parameters<typeof ReviewPanel>[0], 'text' | 'onTextChange'>) {
  const [text, setText] = useState<ReviewDraftText>({ event: 'COMMENT', body: '' });
  return <ReviewPanel {...props} text={text} onTextChange={setText} />;
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
    expect(props.onOpenHome).toHaveBeenCalledWith('F1.S1', {
      path: 'src/a.ts',
      side: 'new',
      line: 5,
    });
    expect(props.onJump).not.toHaveBeenCalled();
  });

  it('a draft no home owns opens its file at the line', () => {
    const props = renderPanel(fakeReview({ drafts: [comment({ startLine: 40, endLine: 41 })] }));
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts:40–41' }));
    expect(props.onJump).toHaveBeenCalledWith('src/a.ts', 41, {
      path: 'src/a.ts',
      side: 'new',
      line: 41,
    });
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
    const at = { path: 'lib/x.ts', side: 'new', line: 12 };
    expect(props.onJump).toHaveBeenCalledWith('lib/x.ts', 12, at);
    fireEvent.click(screen.getByRole('button', { name: 'reply in lib/x.ts' }));
    expect(props.onJump).toHaveBeenCalledTimes(2);
    expect(props.onJump).toHaveBeenLastCalledWith('lib/x.ts', 12, at);
  });

  it('a thread without a line is file-level: it opens the file at the top', () => {
    const props = renderPanel(
      fakeReview({ threads: [thread({ path: 'lib/x.ts', line: null, side: null })] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'lib/x.ts' }));
    expect(props.onJump).toHaveBeenCalledWith('lib/x.ts', 1, {
      path: 'lib/x.ts',
      side: null,
      line: null,
    });
  });

  it('a thread with a line but no side is file-level too', () => {
    const props = renderPanel(fakeReview({ threads: [thread({ path: 'src/a.ts', line: null })] }));
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }));
    // src/a.ts line 1 belongs to a step, but a file-level thread has no line to open.
    expect(props.onOpenHome).not.toHaveBeenCalled();
    expect(props.onJump).toHaveBeenCalledWith('src/a.ts', 1, {
      path: 'src/a.ts',
      side: null,
      line: null,
    });
  });

  it('an outdated thread shows the comments on the file, not a line', () => {
    const props = renderPanel(
      fakeReview({ threads: [thread({ path: 'lib/x.ts', line: 12, outdated: true })] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'lib/x.ts:12' }));
    expect(props.onJump).toHaveBeenCalledWith('lib/x.ts', 12, {
      path: 'lib/x.ts',
      side: null,
      line: null,
    });
  });

  it('a draft made on an older version shows the comments on the file, not a line', () => {
    const props = renderPanel(fakeReview({ drafts: [comment({ headSha: 'c'.repeat(40) })] }));
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts:5' }));
    expect(props.onOpenHome).toHaveBeenCalledWith('F1.S1', {
      path: 'src/a.ts',
      side: null,
      line: null,
    });
  });

  it('"Go to it" opens the home without a place: its start is shown', () => {
    const props = renderPanel(fakeReview(), { isSeen: (id) => id !== 'F1.S3' });
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to it' }));
    expect(props.onOpenHome).toHaveBeenCalledWith('F1.S3');
  });

  it('moves focus to its heading when it opens', () => {
    renderPanel();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Review' }));
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

describe('ReviewPanel: possible problems in the approve reminder', () => {
  const bug = problem('p1', 'bug', line('src/a.ts', 5), 'F1.S3', { title: 'The fee is lost' });
  const risk = problem('p2', 'risk', line('src/a.ts', 7), 'F1.S1', { title: 'Two repays race' });
  const look = problem('p3', 'look', line('m.sql', 2), 'f1', { title: 'Name is unclear' });
  const ci = problem('p4', 'bug', { kind: 'pr' }, null, {
    title: 'CI check "test" fails',
    url: 'https://github.com/acme/loans/actions/runs/1',
  });
  const approve = () => fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));

  it('lists unmarked problems above unseen items when approving', () => {
    const onGoTo = vi.fn();
    renderPanel(fakeReview(), {
      isSeen: (id) => id !== 'f1',
      problems: { problems: [bug, ci, risk, look], onGoTo },
    });
    expect(screen.queryByRole('region', { name: 'Possible problems not marked' })).toBeNull();
    approve();

    const section = screen.getByRole('region', { name: 'Possible problems not marked' });
    expect(within(section).getByText('4 possible problems are not marked')).toBeTruthy();
    const items = within(section).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Likely bug.*The fee is lost/),
      expect.stringMatching(/^Likely bug.*CI check "test" fails/),
      expect.stringMatching(/^Risk.*Two repays race/),
      expect.stringMatching(/^Worth a look.*Name is unclear/),
    ]);
    const unseen = screen.getByRole('region', { name: 'Not seen yet' });
    expect(section.compareDocumentPosition(unseen) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(items[0]!).getByRole('button', { name: 'Go to it' }));
    expect(onGoTo).toHaveBeenCalledWith(bug);

    // A PR-wide problem has no place to go: its title links to the run instead.
    expect(within(items[1]!).queryByRole('button', { name: 'Go to it' })).toBeNull();
    const link = within(items[1]!).getByRole('link', { name: 'CI check "test" fails' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/loans/actions/runs/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('says "1 possible problem is not marked" for one', () => {
    renderPanel(fakeReview(), { problems: { problems: [risk] } });
    approve();
    expect(screen.getByText('1 possible problem is not marked')).toBeTruthy();
  });

  it('a problem with no home and no safe url has no button and no link', () => {
    const elsewhere = problem('p5', 'risk', line('lib/x.ts', 3), null, { title: 'Off the tour' });
    const unsafe = problem('p6', 'bug', { kind: 'pr' }, null, {
      title: 'Bad link',
      url: 'javascript:alert(1)',
    });
    renderPanel(fakeReview(), { problems: { problems: [unsafe, elsewhere] } });
    approve();
    const section = screen.getByRole('region', { name: 'Possible problems not marked' });
    expect(within(section).queryByRole('button')).toBeNull();
    expect(within(section).queryByRole('link')).toBeNull();
    expect(within(section).getByText('Bad link')).toBeTruthy();
  });

  it('lists problems marked real as a last warning', () => {
    const onGoTo = vi.fn();
    const marks: Record<string, 'real' | 'not'> = { p1: 'real', p2: 'real' };
    renderPanel(fakeReview(), {
      problems: { problems: [bug, risk, look], markOf: (k) => marks[k], onGoTo },
    });
    approve();

    const unmarked = screen.getByRole('region', { name: 'Possible problems not marked' });
    expect(within(unmarked).getByText('1 possible problem is not marked')).toBeTruthy();
    const real = screen.getByRole('region', { name: 'Problems you marked real' });
    expect(within(real).getByText('You marked 2 as real problems')).toBeTruthy();
    const items = within(real).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Likely bug.*The fee is lost/),
      expect.stringMatching(/^Risk.*Two repays race/),
    ]);
    expect(unmarked.compareDocumentPosition(real) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(items[1]!).getByRole('button', { name: 'Go to it' }));
    expect(onGoTo).toHaveBeenCalledWith(risk);
  });

  it('says "You marked 1 as a real problem" for one', () => {
    renderPanel(fakeReview(), {
      problems: { problems: [bug], markOf: (k) => (k === 'p1' ? 'real' : undefined) },
    });
    approve();
    expect(screen.getByText('You marked 1 as a real problem')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Possible problems not marked' })).toBeNull();
  });

  it('leaves out problems marked not a problem', () => {
    renderPanel(fakeReview(), {
      problems: { problems: [bug, risk], markOf: (k) => (k === 'p1' ? 'not' : undefined) },
    });
    approve();
    const section = screen.getByRole('region', { name: 'Possible problems not marked' });
    expect(within(section).getByText('1 possible problem is not marked')).toBeTruthy();
    expect(screen.queryByText('The fee is lost')).toBeNull();
  });

  it('says Approve anyway when problems are open', () => {
    renderPanel(fakeReview(), { isSeen: () => true, problems: { problems: [look] } });
    approve();
    expect(submitButton().textContent).toBe('Approve anyway');
  });

  it('says Approve anyway when only a problem marked real is left', () => {
    renderPanel(fakeReview(), {
      problems: { problems: [look], markOf: () => 'real' },
    });
    approve();
    expect(submitButton().textContent).toBe('Approve anyway');
  });

  it('says Submit review when every problem is marked not a problem', () => {
    renderPanel(fakeReview(), { problems: { problems: [look], markOf: () => 'not' } });
    approve();
    expect(submitButton().textContent).toBe('Submit review');
  });

  it('shows nothing when Comment is chosen', () => {
    renderPanel(fakeReview(), {
      problems: { problems: [bug, risk], markOf: (k) => (k === 'p1' ? 'real' : undefined) },
    });
    expect(screen.queryByRole('region', { name: 'Possible problems not marked' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Problems you marked real' })).toBeNull();
    expect(submitButton().textContent).toBe('Submit review');
  });
});

describe('ReviewPanel: older-version label', () => {
  it("follows the tour's head, not the head the review was loaded with", () => {
    // The review still knows an older head (it has not reloaded since a rebuild).
    renderPanel(
      fakeReview({
        headSha: 'c'.repeat(40),
        drafts: [comment(), comment({ id: 8, headSha: 'c'.repeat(40) })],
      }),
    );
    const items = within(screen.getByRole('list', { name: 'Pending comments' })).getAllByRole(
      'listitem',
    );
    expect(within(items[0]!).queryByText('older version')).toBeNull();
    expect(within(items[1]!).queryByText('older version')).toBeTruthy();
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
      expect(review.submit).toHaveBeenCalledWith('REQUEST_CHANGES', 'Needs a test.', tour.headSha),
    );
  });

  it('on success says "Review sent" with a link; following it closes the panel', async () => {
    const review = fakeReview({ drafts: [comment()] });
    vi.mocked(review.submit).mockResolvedValue({ url: 'https://github.com/r/1', sent: [7] });
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

  it('a submit refused because the tour changed shows why and keeps the summary', async () => {
    const review = fakeReview({ drafts: [comment()] });
    const failed = { message: 'The tour changed. Reload the page.', failedDraftId: null };
    let current: ReviewState = review;
    vi.mocked(review.submit).mockImplementation(() => {
      current = { ...review, submitError: failed };
      return Promise.resolve(null);
    });
    const props = {
      tour,
      isSeen: () => true,
      onOpenHome: vi.fn(),
      onJump: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<Harness {...props} review={current} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Looks fine.' },
    });
    fireEvent.click(submitButton());
    await vi.waitFor(() => expect(review.submit).toHaveBeenCalled());
    rerender(<Harness {...props} review={current} />);

    expect(screen.getByRole('alert').textContent).toBe('The tour changed. Reload the page.');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Summary' }).value).toBe(
      'Looks fine.',
    );
  });

  it('Request changes needs a summary, even with pending comments', () => {
    renderPanel(fakeReview({ drafts: [comment()] }));
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Request changes needs a summary.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: '   ' },
    });
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Needs a test.' },
    });
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Request changes needs a summary.')).toBeNull();
  });

  it('after "Review sent" there is no hint about an empty review', async () => {
    const review = fakeReview();
    vi.mocked(review.submit).mockResolvedValue({ url: 'https://github.com/r/1', sent: [7] });
    renderPanel(review);
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Fine.' },
    });
    fireEvent.click(submitButton());
    await screen.findByText(/Review sent/);
    expect(screen.queryByText('Write a summary or add a comment first.')).toBeNull();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Summary' }).value).toBe('');
  });

  it('a draft cannot be deleted while sending', () => {
    renderPanel({ ...fakeReview({ drafts: [comment()] }), submitting: true });
    const del = within(panel()).getByRole('button', { name: /^Delete draft on/ });
    expect((del as HTMLButtonElement).disabled).toBe(true);
  });

  it('typing a new summary after "Review sent" clears it, and the hint is back', async () => {
    const review = fakeReview();
    vi.mocked(review.submit).mockResolvedValue({ url: 'https://github.com/r/1', sent: [] });
    renderPanel(review);
    const summary = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Summary' });
    fireEvent.change(summary(), { target: { value: 'Fine.' } });
    fireEvent.click(submitButton());
    await screen.findByText(/Review sent/);

    fireEvent.change(summary(), { target: { value: 'More' } });
    expect(screen.queryByText(/Review sent/)).toBeNull();
    fireEvent.change(summary(), { target: { value: '' } });
    expect(screen.getByText('Write a summary or add a comment first.')).toBeTruthy();
  });

  it('a new draft after "Review sent" clears it', async () => {
    const review = fakeReview();
    vi.mocked(review.submit).mockResolvedValue({ url: 'https://github.com/r/1', sent: [] });
    const props = {
      tour,
      isSeen: () => true,
      onOpenHome: vi.fn(),
      onJump: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<Harness {...props} review={review} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Fine.' },
    });
    fireEvent.click(submitButton());
    await screen.findByText(/Review sent/);

    rerender(<Harness {...props} review={{ ...review, drafts: [comment()] }} />);
    expect(screen.queryByText(/Review sent/)).toBeNull();
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
