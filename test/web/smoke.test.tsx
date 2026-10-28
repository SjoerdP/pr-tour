import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// Proves the `web` vitest project is wired: jsdom, React and testing-library.
// Delete once real web tests exist.
describe('web test project', () => {
  it('renders React into jsdom', () => {
    render(<p>pr-tour</p>);
    expect(screen.getByText('pr-tour').tagName).toBe('P');
  });
});
