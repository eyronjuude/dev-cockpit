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
     * These are integration tests: real git, real worktrees, real validation
     * subprocesses, running in parallel forks that compete for the same CPU
     * and disk. On Windows a `git worktree` operation costs seconds on its own
     * and gets slower as the other workers pile on. At 30s the landing suites
     * passed alone and failed between two and six tests at random in a full
     * run, and a timeout reports as a failure of whatever the test was
     * asserting rather than as "the machine was busy" — an expensive thing to
     * debug twice.
     */
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
