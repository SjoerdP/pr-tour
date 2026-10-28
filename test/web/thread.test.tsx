import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Draft, ReviewThread, ThreadComment } from '../../src/shared/review.js';
import { Thread } from '../../src/web/Thread.js';

// One review thread from GitHub, with its pending reply drafts.

const NOW = new Date('2026-10-28T12:00:00Z');

function comment(id: string, overrides: Partial<ThreadComment> = {}): ThreadComment {
  return {
    id,
    author: 'alice',
    body: `Body of ${id}`,
    createdAt: '2026-10-28T09:00:00Z',
    url: `https://github.com/acme/loans/pull/42#discussion_${id}`,
    ...overrides,
  };
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'T1',
    path: 'src/loan.ts',
    side: 'new',
    line: 12,
    startLine: null,
    outdated: false,
    resolved: false,
    comments: [comment('c1'), comment('c2', { author: 'bob', createdAt: '2026-10-28T11:58:00Z' })],
    ...overrides,
  };
}

function reply(id: number, body: string, threadId = 'T1'): Draft {
  return { id, kind: 'reply', threadId, body, createdAt: '2026-10-28T11:00:00Z' };
}

type Options = Partial<Parameters<typeof Thread>[0]>;

function renderThread(options: Options = {}) {
  const props = {
    thread: thread(),
    drafts: [] as Draft[],
    viewerIsAuthor: false,
    onReply: vi.fn(() => Promise.resolve()),
    onEditDraft: vi.fn(() => Promise.resolve()),
    onDeleteDraft: vi.fn(() => Promise.resolve()),
    onResolve: vi.fn(() => Promise.resolve()),
    now: NOW,
    ...options,
  };
  render(<Thread {...props} />);
  return props;
}

describe('Thread: comments', () => {
  it('shows each comment with author, relative time and a GitHub link', () => {
    renderThread();
    const items = screen.getAllByRole('article');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('alice')).toBeTruthy();
    expect(within(items[0]!).getByText('3h ago')).toBeTruthy();
    expect(within(items[1]!).getByText('bob')).toBeTruthy();
    expect(within(items[1]!).getByText('2m ago')).toBeTruthy();
    const link = within(items[0]!).getByRole('link', { name: 'view on GitHub' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/loans/pull/42#discussion_c1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('shows the body as plain text, line breaks kept, markup not parsed', () => {
    const body = 'First line\nSecond <b>bold</b> [link](https://evil.example)';
    renderThread({ thread: thread({ comments: [comment('c1', { body })] }) });
    const text = screen.getByText(/First line/);
    expect(text.textContent).toBe(body);
    expect(document.querySelector('b')).toBeNull();
    expect(screen.queryByRole('link', { name: 'link' })).toBeNull();
  });

  it('shows a suggestion block as code labeled "Suggested change"', () => {
    const body = 'Try this:\n```suggestion\nconst a = 1;\nconst b = 2;\n```\nThanks';
    renderThread({ thread: thread({ comments: [comment('c1', { body })] }) });
    const figure = screen.getByRole('figure', { name: 'Suggested change' });
    expect(
      within(figure)
        .getByText(/const a = 1;/)
        .closest('pre'),
    ).toBeTruthy();
    expect(figure.querySelector('code')!.textContent).toBe('const a = 1;\nconst b = 2;');
    expect(screen.getByText('Try this:')).toBeTruthy();
    expect(screen.getByText('Thanks')).toBeTruthy();
  });

  it('a comment URL that is not https is plain text, not a link', () => {
    renderThread({
      thread: thread({ comments: [comment('c1', { url: 'javascript:alert(1)' })] }),
    });
    const item = screen.getByRole('article');
    expect(within(item).queryByRole('link')).toBeNull();
    expect(within(item).getByText('view on GitHub')).toBeTruthy();
    expect(item.innerHTML).not.toContain('javascript:');
  });

  it('labels an outdated thread', () => {
    renderThread({ thread: thread({ outdated: true }) });
    expect(screen.getByText('Outdated')).toBeTruthy();
  });
});

describe('Thread: resolved', () => {
  it('is collapsed to one line and expands on click', () => {
    renderThread({ thread: thread({ resolved: true }) });
    const toggle = screen.getByRole('button', { name: 'Resolved · 2 comments' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('article')).toHaveLength(0);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Unresolve' })).toBeTruthy();
  });

  it('says "1 comment" for one comment', () => {
    renderThread({ thread: thread({ resolved: true, comments: [comment('c1')] }) });
    expect(screen.getByRole('button', { name: 'Resolved · 1 comment' })).toBeTruthy();
  });

  it('Unresolve calls onResolve(false)', () => {
    const { onResolve } = renderThread({ thread: thread({ resolved: true }) });
    fireEvent.click(screen.getByRole('button', { name: /Resolved ·/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Unresolve' }));
    expect(onResolve).toHaveBeenCalledWith(false);
  });
});

describe('Thread: actions', () => {
  it('Resolve calls onResolve(true)', () => {
    const { onResolve } = renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it('the author of the PR can reply and resolve too', () => {
    renderThread({ viewerIsAuthor: true });
    expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy();
  });

  it('a failed resolve shows a short error', async () => {
    renderThread({ onResolve: vi.fn(() => Promise.reject(new Error('No access'))) });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No access');
  });

  it('Reply opens a composer; submitting calls onReply and closes it', async () => {
    const { onReply } = renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Agreed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reply' }));
    expect(onReply).toHaveBeenCalledWith('Agreed');
    await vi.waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('a failed reply keeps the composer and the text', async () => {
    renderThread({ onReply: vi.fn(() => Promise.reject(new Error('Offline'))) });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
    fireEvent.change(textarea, { target: { value: 'Agreed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reply' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Offline');
    expect(textarea.value).toBe('Agreed');
  });

  it('cancelling the reply composer closes it', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('Thread: pending reply drafts', () => {
  it('shows only this thread\'s reply drafts, labeled "Pending"', () => {
    renderThread({ drafts: [reply(1, 'My pending reply'), reply(2, 'Other thread', 'T2')] });
    const pending = screen.getByText('My pending reply').closest('.draft-card') as HTMLElement;
    expect(within(pending).getByText('Pending')).toBeTruthy();
    expect(screen.queryByText('Other thread')).toBeNull();
  });

  it('Edit opens a composer with the draft text and saves via onEditDraft', async () => {
    const { onEditDraft } = renderThread({ drafts: [reply(7, 'Old text')] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
    expect(textarea.value).toBe('Old text');
    fireEvent.change(textarea, { target: { value: 'New text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onEditDraft).toHaveBeenCalledWith(7, 'New text');
    await vi.waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('Delete calls onDeleteDraft; a failure shows a short error', async () => {
    const onDeleteDraft = vi.fn(() => Promise.reject(new Error('Gone wrong')));
    renderThread({ drafts: [reply(7, 'Old text')], onDeleteDraft });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteDraft).toHaveBeenCalledWith(7);
    expect((await screen.findByRole('alert')).textContent).toContain('Gone wrong');
    expect(screen.getByText('Old text')).toBeTruthy();
  });
});
