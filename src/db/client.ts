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

interface TableInfoRow {
  name: unknown;
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

  repairSkippedAdditiveMigrations(sqlite);

  return { db, sqlite };
}

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as TableInfoRow[];
  return rows.some((row) => row.name === column);
}

/**
 * Migration 0006 was created with a timestamp older than migrations already
 * present in some local databases. Drizzle compares pending migrations against
 * the latest `created_at`, so those databases can skip the file even though the
 * schema still needs these additive columns.
 */
function repairSkippedAdditiveMigrations(sqlite: Database.Database): void {
  if (!columnExists(sqlite, 'artifacts', 'expired_at')) {
    sqlite.prepare('ALTER TABLE "artifacts" ADD "expired_at" text').run();
  }

  if (!columnExists(sqlite, 'projects', 'worktree_retention_days')) {
    sqlite
      .prepare(
        'ALTER TABLE "projects" ADD "worktree_retention_days" integer DEFAULT 7 NOT NULL',
      )
      .run();
  }
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
