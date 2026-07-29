export default [
  {
    files: ['src/**/*.js', 'bin/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        Response: 'readonly',
        structuredClone: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      eqeqeq: 'error',
      'no-undef': 'error',
      'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
    },
  },
];
