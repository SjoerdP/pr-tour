import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor give up after 1 s by default. A full run loads every core (jsdom workers plus
// the Go checker build), and a load chain of mocked fetches and renders has been seen to miss
// that budget. 3 s is far above a normal wait (under 0.5 s even then) and still inside the 5 s
// test timeout, so a real miss still fails with testing-library's DOM dump.
configure({ asyncUtilTimeout: 3000 });

// Unmount rendered components after each test. Testing-library only does this
// automatically when vitest globals are on, which they are not.
// Storage is cleared too: the tour view remembers per PR whether "About" was shown.
afterEach(() => {
  cleanup();
  localStorage.clear();
});
