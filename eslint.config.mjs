import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '**/dist/**',
      'build/**',
      '**/build/**',
      'coverage/**',
      '.tmp/**',
      'playwright-report/**',
      'test-results/**',
      'apps/web/public/vision/**',
      'apps/api/vendor/**',
      'apps/desktop/out*/**',
    ],
  },
  {
    ...eslint.configs.recommended,
    files: ['**/*.mjs', '**/*.js'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-console': 'off',
      // `_name` marks an intentionally unused parameter; ignored catch bindings are fine.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Node build scripts written as CommonJS.
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
