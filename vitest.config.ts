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
    // These are integration tests: real git, real worktrees, real validation
    // subprocesses, running in parallel forks that compete for the same CPU
    // and disk. 30s was enough until it wasn't, and a timeout here reports as
    // a failure of whatever the test was asserting rather than as "the
    // machine was busy", which is an expensive thing to debug twice.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
