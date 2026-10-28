// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

// ---------------------------------------------------------------------------
// Import boundaries (see docs/architecture.md, "Dependency rules").
//
//   shared  imports nothing from server or web, and no Node built-ins
//   web     imports shared only (plus packages); no server, no Node built-ins
//   server  imports shared and server; never web
//   cli     imports server and shared; never web
//
// Enforced with `no-restricted-imports` on the import specifier text, so no
// resolver is needed. A relative import that leaves the current layer looks
// like `../server/x.js` or `../../server/x.js` (first non-`..` segment names
// the layer); a test import looks like `../../src/server/x.js`.
// ---------------------------------------------------------------------------

/** @param {string} layer */
const relativeImportOf = (layer) => `^\\.\\.?/(\\.\\./)*${layer}/`;
/** @param {string} layer */
const testImportOf = (layer) => `/src/${layer}/`;

const bareBuiltins = builtinModules.filter((name) => !name.startsWith('node:'));

/** Forbid Node built-ins without the `node:` prefix (server/cli). */
const preferNodeProtocol = {
  paths: bareBuiltins.map((name) => ({
    name,
    message: `Import Node built-ins with the node: prefix (node:${name}).`,
  })),
};

/** Forbid Node built-ins altogether (shared/web must run in the browser). */
const noNodeBuiltins = [
  ...bareBuiltins.map((name) => ({
    name,
    message: 'This layer runs in the browser; Node built-ins are not allowed here.',
  })),
];

/** @param {string} layer @param {string} message */
const noLayer = (layer, message) => [
  { regex: relativeImportOf(layer), message },
  { regex: testImportOf(layer), message },
];

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.superpowers/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Plain JS at the repo root (this file) is not covered by a tsconfig.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['src/web/**/*.{ts,tsx}', 'test/web/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },

  // --- boundaries -----------------------------------------------------------
  {
    files: ['src/shared/**/*.ts', 'test/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: noNodeBuiltins,
          patterns: [
            { regex: '^node:', message: 'shared must not use Node built-ins.' },
            ...noLayer('server', 'shared must not import server code.'),
            ...noLayer('web', 'shared must not import web code.'),
          ],
        },
      ],
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}', 'test/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: noNodeBuiltins,
          patterns: [
            { regex: '^node:', message: 'web must not use Node built-ins.' },
            ...noLayer(
              'server',
              'web must not import server code; put shared types in src/shared.',
            ),
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/**/*.ts', 'src/cli.ts', 'test/server/**/*.ts', 'test/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...preferNodeProtocol,
          patterns: noLayer('web', 'server must not import web code.'),
        },
      ],
    },
  },

  prettier,
);
