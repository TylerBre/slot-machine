import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'assets/'] },
  js.configs.recommended,
  {
    // bin/* are extensionless ESM entry points; list them alongside *.mjs.
    files: ['**/*.mjs', 'bin/*'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
