import 'server-only';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';

import * as schema from './schema';
import { dbPath, ensureDataDirs } from '@/core/paths';

export type Db = BetterSQLite3Database<typeof schema>;

interface DbHandle {
  db: Db;
  sqlite: Database.Database;
}

/**
 * Next.js reloads modules on every edit in dev. A module-level singleton would
 * open a new SQLite handle each time and leak them, so the handle is parked on
 * globalThis.
 */
const GLOBAL_KEY = '__devCockpitDb__' as const;

type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: DbHandle };

function migrationsFolder(): string {
  // Resolved from cwd rather than import.meta.url: Next copies compiled output
  // into .next, and the SQL files are not part of that bundle.
  return path.join(process.cwd(), 'src', 'db', 'migrations');
}

function open(): DbHandle {
  ensureDataDirs();
  const file = dbPath();
  const sqlite = new Database(file);

  // WAL keeps the long-running orchestrator writes from blocking UI reads.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // A validation run can hold a write transaction briefly; wait rather than
  // throwing SQLITE_BUSY at the UI.
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  const db = drizzle(sqlite, { schema });

  const folder = migrationsFolder();
  if (fs.existsSync(folder)) {
    migrate(db, { migrationsFolder: folder });
  } else {
    throw new Error(
      `Database migrations are missing at ${folder}. Run "npm run db:generate" first.`,
    );
  }

  return { db, sqlite };
}

export function getDb(): Db {
  const g = globalThis as GlobalWithDb;
  g[GLOBAL_KEY] ??= open();
  return g[GLOBAL_KEY].db;
}

/** Raw handle, for the few places that need a transaction or a pragma. */
export function getSqlite(): Database.Database {
  const g = globalThis as GlobalWithDb;
  g[GLOBAL_KEY] ??= open();
  return g[GLOBAL_KEY].sqlite;
}

/** Test seam. Closes and forgets the handle. */
export function closeDb(): void {
  const g = globalThis as GlobalWithDb;
  const handle = g[GLOBAL_KEY];
  if (!handle) return;
  handle.sqlite.close();
  delete g[GLOBAL_KEY];
}

export { schema };
