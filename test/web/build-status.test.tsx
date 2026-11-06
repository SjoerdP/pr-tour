import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildStatus } from '../../src/web/BuildStatus.js';

const noop = () => {};

describe('BuildStatus', () => {
  it('shows what Claude is doing below the log while the build runs', () => {
    render(
      <BuildStatus
        build={{
          state: 'running',
          log: ['Asking Claude for a tour'],
          progress: 'Claude has read 3 files and run 1 search',
        }}
        onRetry={noop}
        onConfirm={noop}
        onCancel={noop}
      />,
    );

    const log = screen.getByLabelText('Build log');
    expect([...log.children].map((line) => line.textContent)).toEqual([
      'Asking Claude for a tour',
      'Claude has read 3 files and run 1 search',
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a clock since the build started that ticks every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T10:04:10Z'));
    render(
      <BuildStatus
        build={{ state: 'running', log: [], startedAt: '2026-11-06T10:00:00Z' }}
        onRetry={noop}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTitle('Time since the build started').textContent).toBe('4:10');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTitle('Time since the build started').textContent).toBe('4:12');
  });

  it('shows no clock without a start time', () => {
    render(
      <BuildStatus
        build={{ state: 'running', log: [] }}
        onRetry={noop}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.queryByTitle('Time since the build started')).toBeNull();
  });

  it('says how long a failed build ran', () => {
    render(
      <BuildStatus
        build={{
          state: 'failed',
          error: 'Claude went silent.',
          log: [],
          startedAt: '2026-11-06T10:00:00Z',
          endedAt: '2026-11-06T10:04:03Z',
        }}
        onRetry={noop}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'The tour build failed after 4 min 3 s: Claude went silent.',
    );
  });
});
