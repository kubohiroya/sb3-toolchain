// SPDX-License-Identifier: MPL-2.0

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'test/fixtures/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'vite.config.ts'],
    rules: {
      eqeqeq: 'error',
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
      '@typescript-eslint/consistent-type-imports': ['error', {prefer: 'type-imports'}],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Test fixtures build and mutate loose JSON-shaped data on purpose.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
  {
    files: ['bin/**/*.mjs', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      eqeqeq: 'error',
      'no-undef': 'error',
      'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
    },
  },
);
