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
    },
  },
];
