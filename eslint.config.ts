// SPDX-License-Identifier: MPL-2.0

import vitest from '@vitest/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Flat config does not read .gitignore, and .claude/worktrees holds nested
    // checkouts of this same repository, so `eslint .` would lint them too.
    ignores: ['dist/**', 'coverage/**', 'test/fixtures/**', '.claude/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['eslint.config.ts', 'scripts/**/*.ts', 'src/**/*.ts', 'test/**/*.ts', 'vite.config.ts'],
    rules: {
      eqeqeq: 'error',
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
      '@typescript-eslint/consistent-type-imports': ['error', {prefer: 'type-imports'}],
    },
  },
  {
    files: ['test/**/*.ts'],
    plugins: {vitest},
    rules: {
      ...vitest.configs.recommended.rules,
      // Test fixtures build and mutate loose JSON-shaped data on purpose.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
);
