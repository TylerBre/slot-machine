// Lint + format via @antfu/eslint-config: opinionated, flat-native, all-in-one (it owns formatting
// via eslint-stylistic, so there is no Prettier). Run `npm run lint` to check, `npm run format` to fix.
// One enforced function style: top-level functions are declarations, callbacks are arrows
// (antfu/top-level-function). This file adopts the preset cleanly; stricter house rules layer on later.
import antfu from '@antfu/eslint-config';

export default antfu(
  {
    type: 'app',
    // Keep the existing house style (semicolons, single quotes) so adopting the preset does not
    // rewrite the whole tree; antfu's correctness/consistency rules still apply on top.
    stylistic: { indent: 2, quotes: 'single', semi: true },
    // This project runs node:test, not vitest - stop antfu rewriting test()/node:test to vitest.
    test: false,
    ignores: ['assets/**', '*.tar.gz', '.superpowers/**', 'docs/**'],
  },
  {
    // sm is a CLI + MCP server - stdout IS the interface - and bin/* are extensionless ESM entries.
    files: ['**/*.mjs', 'bin/*'],
    languageOptions: { sourceType: 'module' },
    rules: {
      'no-console': 'off', // stdout is the interface
      'node/prefer-global/process': 'off', // global process is idiomatic in a Node app
      'no-use-before-define': 'off', // allow hoisted declarations / established ordering
      'regexp/no-unused-capturing-group': 'off', // harmless capture groups in tmux/parse regexes
      'perfectionist/sort-imports': 'off', // keep each file's leading doc comment above its imports
      // house discipline: describe intent, never single-letter identifiers
      'id-length': ['error', { min: 2, exceptions: ['_'], properties: 'never' }],
      // house discipline: JSDoc on the public (exported) API - one-liners are welcome on top of it
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: true,
        require: { FunctionDeclaration: true, ArrowFunctionExpression: true, FunctionExpression: true },
      }],
    },
  },
);
