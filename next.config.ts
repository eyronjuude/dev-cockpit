import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: {
    // Dev Cockpit runs itself inside its own worktrees
    // (data/worktrees/<project>/<run>), each with its own lockfile several
    // directories below the main checkout's. Left to auto-detect, Turbopack
    // walks past this project's own lockfile up to that outer one and treats
    // it as the root, then resolves this project's own node_modules as
    // outside its filesystem root. Pinning root to this config file's own
    // directory stops it there.
    root: __dirname,
  },
  // better-sqlite3 is a native addon: it must stay outside the bundler.
  serverExternalPackages: ['better-sqlite3'],
  outputFileTracingExcludes: {
    '/*': [
      './data/worktrees/**/*',
      './data/landings/**/*',
      './data/artifacts/**/*',
      './data/attachments/**/*',
    ],
  },
  // The orchestrator holds long-lived child processes in module scope. Double
  // mounting in dev would spawn duplicates of everything.
  reactStrictMode: false,
  experimental: {
    // Route handlers stream SSE for the lifetime of a run.
    proxyTimeout: 0,
  },
};

export default nextConfig;
