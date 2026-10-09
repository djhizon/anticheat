import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    // Agent worktrees live under .claude/ and must never run with the main suite.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
