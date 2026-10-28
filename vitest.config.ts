import { configDefaults, defineConfig } from 'vitest/config';

// Two test projects, chosen by directory, so test files need no per-file
// environment comments:
//   node  test/**        (server, shared, cli)  runs under Node
//   web   test/web/**    (React components)     runs under jsdom
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/web/**'],
        },
      },
      {
        extends: './vite.config.ts',
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['test/web/**/*.test.{ts,tsx}'],
          setupFiles: ['test/web/setup.ts'],
          // Process the stylesheet so test/web/layout-css.test.ts can read it with `?raw`.
          css: { include: [/styles\.css/] },
        },
      },
    ],
  },
});
