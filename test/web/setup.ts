import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Unmount rendered components after each test. Testing-library only does this
// automatically when vitest globals are on, which they are not.
// Storage is cleared too: the tour view remembers per PR whether "About" was shown.
afterEach(() => {
  cleanup();
  localStorage.clear();
});
