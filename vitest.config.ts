import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * The landing suites drive real `git worktree` operations, which on
     * Windows cost seconds each and get slower as the other forked workers
     * compete for the disk. At 30s they passed alone and failed between two
     * and six tests at random in a full run — a suite that reports a different
     * answer each time is worse than a slow one.
     */
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
