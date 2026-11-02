import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
