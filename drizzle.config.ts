import { defineConfig } from 'drizzle-kit';

import { dataDir, dbPath, ensureDir } from './src/core/paths';

// better-sqlite3 does not create parent directories, and on a fresh
// checkout nothing has called ensureDataDirs() yet — `npm run dev` is what
// normally creates data/, but `drizzle-kit migrate` connects before that.
ensureDir(dataDir());

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: { url: dbPath() },
  strict: true,
  verbose: true,
});
