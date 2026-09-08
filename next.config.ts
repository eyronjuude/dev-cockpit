import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon: it must stay outside the bundler.
  serverExternalPackages: ['better-sqlite3'],
  // The orchestrator holds long-lived child processes in module scope. Double
  // mounting in dev would spawn duplicates of everything.
  reactStrictMode: false,
  experimental: {
    // Route handlers stream SSE for the lifetime of a run.
    proxyTimeout: 0,
  },
};

export default nextConfig;
